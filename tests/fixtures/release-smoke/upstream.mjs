import http from "node:http";
import https from "node:https";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import forge from "node-forge";
import { fileURLToPath } from "node:url";

export function certificates() {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = "01";
  cert.validity.notBefore = new Date(Date.now() - 60000);
  cert.validity.notAfter = new Date(Date.now() + 86400000);
  const attributes = [{ name: "commonName", value: "release-smoke-only" }];
  cert.setSubject(attributes); cert.setIssuer(attributes);
  cert.setExtensions([
    { name: "basicConstraints", cA: true },
    { name: "subjectAltName", altNames: [
      ...["localhost", "maas.qianwenaiapi.com", "token-plan.maas.qianwenaiapi.com"].map((value) => ({ type: 2, value })),
      { type: 7, ip: "127.0.0.1" },
    ] },
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return { key: forge.pki.privateKeyToPem(keys.privateKey), cert: forge.pki.certificateToPem(cert) };
}

const listen = (server, port, host) => new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(port, host, () => resolve(server.address().port));
});

export async function startUpstream({ tls = null, port = 0, proxyPort = 0, controlPort = 0, host = "127.0.0.1" } = {}) {
  const sockets = new Set();
  const records = [];
  let active = 0;
  let proxyConnects = 0;
  const track = (server) => server.on("connection", (socket) => {
    sockets.add(socket); socket.on("error", () => {});
    socket.once("close", () => sockets.delete(socket));
  });
  const handler = async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    let body = {};
    try { body = JSON.parse(raw || "{}"); } catch { /* fixture handles malformed bodies */ }
    const marker = JSON.stringify(body);
    const stage = req.url.match(/stage-([a-z-]+)/)?.[1] || marker.match(/smoke-stage-([a-z-]+)/)?.[1] || "healthy";
    // Never persist request text, credentials or tool arguments.
    records.push({ path: req.url.split("?")[0], stage, model: body.model || null, stream: body.stream === true, authPresent: Boolean(req.headers.authorization) });
    active++;
    res.once("close", () => active--);
    if (stage === "headers") return;
    if (stage === "retry") { res.writeHead(503); res.end('{"error":{"message":"fixture retry"}}'); return; }
    if (stage === "fallback" && req.headers.host === "maas.qianwenaiapi.com") { res.writeHead(503); res.end('{"error":{"message":"fixture model fallback"}}'); return; }
    if (req.url.endsWith("/models")) { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ data: [{ id: "qwen3.8-flash", capabilities: { vision: true } }] })); return; }
    const format = req.url.endsWith("/responses") ? "responses" : req.url.endsWith("/messages") ? "claude" : "chat";
    if (stage === "body") { res.writeHead(200, { "content-type": "application/json" }); res.flushHeaders(); res.write('{"id":'); return; }
    const event = (type, data) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    if (body.stream || stage === "first-chunk" || stage === "midstream") {
      res.writeHead(200, { "content-type": "text/event-stream" }); res.flushHeaders();
      if (stage === "first-chunk") return;
      if (format === "responses") {
        res.write(event("response.created", { type: "response.created", response: { id: "resp_fixture", status: "in_progress" } }));
        res.write(event("response.output_text.delta", { type: "response.output_text.delta", delta: "fixture ok" }));
        if (stage === "midstream") return;
        res.end(event("response.completed", { type: "response.completed", response: { id: "resp_fixture", status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "fixture ok" }] }], usage: { input_tokens: 3, output_tokens: 4 } } }));
      } else if (format === "claude") {
        res.write(event("message_start", { type: "message_start", message: { id: "msg_fixture", type: "message", role: "assistant", model: body.model, content: [], usage: { input_tokens: 3, output_tokens: 0 } } }));
        res.write(event("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }));
        res.write(event("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "fixture ok" } }));
        if (stage === "midstream") return;
        res.end(event("content_block_stop", { type: "content_block_stop", index: 0 }) + event("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 4 } }) + event("message_stop", { type: "message_stop" }));
      } else {
        res.write(`data: ${JSON.stringify({ id: "chat_fixture", object: "chat.completion.chunk", model: body.model, choices: [{ index: 0, delta: { role: "assistant", content: "fixture ok" }, finish_reason: null }] })}\n\n`);
        if (stage === "midstream") return;
        res.end(`data: ${JSON.stringify({ id: "chat_fixture", object: "chat.completion.chunk", model: body.model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 } })}\n\ndata: [DONE]\n\n`);
      }
      return;
    }
    const result = format === "responses"
      ? { id: "resp_fixture", object: "response", status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "fixture ok" }] }], usage: { input_tokens: 3, output_tokens: 4 } }
      : format === "claude"
        ? { id: "msg_fixture", type: "message", role: "assistant", model: body.model, content: [{ type: "text", text: "fixture ok" }], stop_reason: "end_turn", usage: { input_tokens: 3, output_tokens: 4 } }
        : { id: "chat_fixture", object: "chat.completion", model: body.model, choices: [{ index: 0, message: { role: "assistant", content: "fixture ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 } };
    res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(result));
  };
  const upstream = tls ? https.createServer(tls, handler) : http.createServer(handler);
  track(upstream);
  const upstreamPort = await listen(upstream, port, host);
  const proxy = http.createServer((req, res) => { res.writeHead(405); res.end(); });
  track(proxy);
  let stalledConnect = false;
  proxy.on("connect", (req, client, head) => {
    proxyConnects++;
    if (stalledConnect) { client.resume(); return; }
    const destination = net.connect(upstreamPort, host === "0.0.0.0" ? "127.0.0.1" : host, () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) destination.write(head);
      client.pipe(destination); destination.pipe(client);
    });
    destination.on("error", () => client.destroy());
    client.once("close", () => destination.destroy());
    destination.once("close", () => client.destroy());
  });
  const actualProxyPort = await listen(proxy, proxyPort, host);
  const control = http.createServer((req, res) => {
    if (req.url === "/stall-connect") {
      stalledConnect = true;
      for (const socket of sockets) socket.destroy();
    }
    if (req.url === "/resume-connect") stalledConnect = false;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ active, sockets: sockets.size, proxyConnects, records: records.slice(-300) }));
  });
  const actualControlPort = await listen(control, controlPort, host);
  return {
    url: `${tls ? "https" : "http"}://127.0.0.1:${upstreamPort}`,
    proxyUrl: `http://127.0.0.1:${actualProxyPort}`,
    controlUrl: `http://127.0.0.1:${actualControlPort}`,
    metrics: () => ({ active, sockets: sockets.size, proxyConnects, requests: records.length }),
    async close() {
      for (const socket of sockets) socket.destroy();
      await Promise.all([upstream, proxy, control].map((s) => new Promise((resolve) => s.close(resolve))));
    },
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = process.env.SMOKE_CERT_DIR;
  if (process.argv.includes("--certificates")) {
    const tls = certificates();
    fs.writeFileSync(path.join(dir, "cert.pem"), tls.cert);
    fs.writeFileSync(path.join(dir, "key.pem"), tls.key, { mode: 0o600 });
    process.exit(0);
  }
  const cert = fs.readFileSync(path.join(dir, "cert.pem"));
  const key = fs.readFileSync(path.join(dir, "key.pem"));
  const fixture = await startUpstream({ tls: { cert, key }, port: 443, proxyPort: 8080, controlPort: 8081, host: "0.0.0.0" });
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => fixture.close().then(() => process.exit(0)));
  console.log("Release fake upstream ready (TLS + CONNECT proxy); no request content logged.");
}
