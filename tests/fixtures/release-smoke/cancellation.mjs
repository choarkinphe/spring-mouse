import assert from "node:assert/strict";
import net from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import fs from "node:fs";
import { startUpstream } from "./upstream.mjs";
import { DefaultExecutor } from "../../../open-sse/executors/default.js";
import { createBypassRequest } from "../../../open-sse/utils/proxyFetch.js";

const fixture = await startUpstream({ tls: { cert: fs.readFileSync(process.env.SMOKE_CERT_DIR + "/cert.pem"), key: fs.readFileSync(process.env.SMOKE_CERT_DIR + "/key.pem") } });
const healthy = async () => {
  const executor = new DefaultExecutor("qianwen");
  const result = await executor.execute({ model: "qwen3.8-flash", body: { model: "qwen3.8-flash", messages: [{ role: "user", content: "fixture" }] }, stream: false, credentials: { apiKey: "fixture-not-real", runtimeTransport: { format: "openai", baseUrl: fixture.url + "/chat/completions" } }, signal: new AbortController().signal });
  assert.equal(result.response.status, 200); await result.response.text();
};
const waitFor = async (check, message) => {
  for (let i = 0; i < 500; i++) { if (check()) return; await sleep(20); }
  assert.fail(message);
};
const outcomes = [];
const socketHandles = () => process._getActiveHandles().filter((h) => h.constructor?.name === "Socket" && h.remoteAddress).length;
try {
  await healthy(); await sleep(100);
  const baseline = { ...fixture.metrics(), handles: socketHandles(), rss: process.memoryUsage().rss };
  for (const proxy of [false, true]) {
    for (const stage of ["headers", "first-chunk", "midstream", "body"]) {
      const signal = new AbortController();
      const executor = new DefaultExecutor("qianwen");
      const sentBefore = fixture.metrics().requests;
      const pending = (async () => {
        const result = await executor.execute({
          model: "qwen3.8-flash", body: { model: "qwen3.8-flash", messages: [{ role: "user", content: "smoke-stage-" + stage }], stream: stage !== "body" }, stream: stage !== "body",
          credentials: { apiKey: "fixture-not-real", runtimeTransport: { format: "openai", baseUrl: fixture.url + "/chat/completions" } }, signal: signal.signal,
          proxyOptions: proxy ? { connectionProxyEnabled: true, connectionProxyUrl: fixture.proxyUrl, strictProxy: true } : null,
        });
        await result.response.text();
      })();
      let failureCode = null;
      const settled = pending.then(() => "unexpected-success", (error) => { failureCode = error.cause?.code || error.code || error.name; return "cancelled"; });
      await waitFor(() => fixture.metrics().requests > sentBefore && fixture.metrics().active > 0, `upstream did not enter stall stage proxy=${proxy} stage=${stage}` ).catch((error) => {
        if (failureCode) error.message += ` failure=${failureCode}`;
        throw error;
      });
      if (proxy) assert.ok(fixture.metrics().proxyConnects > 0, "proxy silently fell back to direct");
      signal.abort(new DOMException("client_abort", "AbortError"));
      assert.equal(await settled, "cancelled");
      await waitFor(() => fixture.metrics().active === 0, "upstream retained cancelled response");
      outcomes.push({ proxy, stage, cancelled: true });
    }
    const executor = new DefaultExecutor("qianwen");
    executor.config = { ...executor.config, retry: { 503: { attempts: 2, delayMs: 500 } } };
    const signal = new AbortController(); const before = fixture.metrics().requests;
    const promise = executor.execute({ model: "qwen3.8-flash", body: { model: "qwen3.8-flash", messages: [{ role: "user", content: "smoke-stage-retry" }] }, stream: false, credentials: { apiKey: "fixture-not-real", runtimeTransport: { format: "openai", baseUrl: fixture.url + "/chat/completions" } }, signal: signal.signal, proxyOptions: proxy ? { connectionProxyEnabled: true, connectionProxyUrl: fixture.proxyUrl, strictProxy: true } : null });
    const settled = promise.then(() => "unexpected-success", () => "cancelled");
    await waitFor(() => fixture.metrics().requests > before, "retry not entered");
    signal.abort(new DOMException("client_abort", "AbortError"));
    assert.equal(await settled, "cancelled"); await sleep(600);
    assert.equal(fixture.metrics().requests, before + 1, "retried after caller cancellation");
    outcomes.push({ proxy, stage: "retry-backoff", cancelled: true });
  }
  const rawSockets = new Set();
  const silent = net.createServer((socket) => { rawSockets.add(socket); socket.on("error", () => {}); socket.resume(); socket.once("close", () => rawSockets.delete(socket)); });
  await new Promise((resolve) => silent.listen(0, "127.0.0.1", resolve));
  try {
    const signal = new AbortController();
    const promise = createBypassRequest(new URL(`https://localhost:${silent.address().port}/chat/completions`), "127.0.0.1", { signal: signal.signal });
    const settled = promise.then(() => "unexpected-success", () => "cancelled");
    await waitFor(() => rawSockets.size > 0, "TLS handshake not entered"); signal.abort(); assert.equal(await settled, "cancelled");
    await waitFor(() => rawSockets.size === 0, "TLS socket retained after cancellation");
    outcomes.push({ proxy: false, stage: "tls-handshake", cancelled: true });
  } finally { for (const s of rawSockets) s.destroy(); await new Promise((resolve) => silent.close(resolve)); }
  // CONNECT negotiation stall covers the proxy connect phase without unreliable
  // unroutable-IP assumptions that vary between developer machines and CI.
  await fetch(fixture.controlUrl + "/stall-connect");
  {
    const signal = new AbortController(); const executor = new DefaultExecutor("qianwen");
    const promise = executor.execute({ model: "qwen3.8-flash", body: {}, stream: false, credentials: { apiKey: "fixture-not-real", runtimeTransport: { format: "openai", baseUrl: fixture.url + "/chat/completions" } }, signal: signal.signal, proxyOptions: { connectionProxyEnabled: true, connectionProxyUrl: fixture.proxyUrl, strictProxy: true } });
    const settled = promise.then(() => "unexpected-success", () => "cancelled"); await sleep(80); signal.abort(); assert.equal(await settled, "cancelled");
    outcomes.push({ proxy: true, stage: "connect", cancelled: true });
  }
  await fetch(fixture.controlUrl + "/resume-connect");
  const before = fixture.metrics().requests;
  const signals = Array.from({ length: 20 }, () => new AbortController());
  const pending = signals.map((signal) => new DefaultExecutor("qianwen").execute({ model: "qwen3.8-flash", body: { model: "qwen3.8-flash", messages: [{ role: "user", content: "smoke-stage-headers" }] }, stream: true, credentials: { apiKey: "fixture-not-real", runtimeTransport: { format: "openai", baseUrl: fixture.url + "/chat/completions" } }, signal: signal.signal }).then(() => "unexpected-success", () => "cancelled"));
  await waitFor(() => fixture.metrics().requests >= before + signals.length, "concurrent stalls did not start");
  signals.forEach((s) => s.abort()); assert.deepEqual(await Promise.all(pending), signals.map(() => "cancelled"));
  await waitFor(() => fixture.metrics().active === 0, "concurrent requests retained");
  await healthy();
  // Undici may replace an aborted connection with an idle keep-alive socket.
  // Observe its natural idle expiry, not an artificial forced pool destroy.
  const recovery = [];
  for (let i = 0; i < 12; i++) {
    recovery.push({ afterMs: i * 1000, handles: socketHandles(), active: fixture.metrics().active, rss: process.memoryUsage().rss });
    if (socketHandles() <= baseline.handles + 4) break;
    await sleep(1000);
  }
  const after = { ...fixture.metrics(), handles: socketHandles(), rss: process.memoryUsage().rss };
  // Pools retain a small bounded number of healthy keep-alive sockets; record
  // actual handles/RSS, never equate pool Map length with OS resources.
  assert.ok(after.handles <= baseline.handles + 12, `socket handles grew: ${baseline.handles} -> ${after.handles}`);
  assert.ok(after.rss <= baseline.rss + 64 * 1024 * 1024, "RSS exceeded bounded test allowance");
  console.log(JSON.stringify({ outcomes, concurrentCancelled: signals.length, baseline, after, recovery, healthyAfterCancel: true }));
} finally { await fixture.close(); }
process.exit(0);
