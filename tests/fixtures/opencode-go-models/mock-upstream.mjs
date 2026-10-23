import http from "node:http";

const port = Number(process.env.MOCK_PORT || 9057);
let mode = "ok";
const requests = [];
http.createServer(async (req, res) => {
  const reply = (status, data) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(data));
  };
  if (req.url === "/health") return reply(200, { ok: true });
  if (req.url === "/state" && req.method === "POST") {
    let body = "";
    for await (const chunk of req) body += chunk;
    mode = JSON.parse(body).mode;
    return reply(200, { mode });
  }
  if (req.url === "/requests") return reply(200, { requests });
  if (req.url === "/chat/completions" && req.method === "POST") {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    requests.push({ path: req.url, session: req.headers["x-opencode-session"], userAgent: req.headers["user-agent"], model: body.model, authorizationPresent: Boolean(req.headers.authorization) });
    if (!req.headers["x-opencode-session"]) return reply(400, { error: { type: "MissingSessionID", message: "Missing conversation session" } });
    if (!req.headers["user-agent"] || /^(node|undici|python|openai)/i.test(req.headers["user-agent"])) return reply(400, { error: { type: "MissingUserAgent", message: "Use own client identity" } });
    if (mode === "reject") return reply(400, { error: { type: "inference_failed", message: "Fixture rejection" } });
    if (body.stream) {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      for (const chunk of [
        { choices: [{ index: 0, delta: { role: "assistant", content: "Go fixture response" }, finish_reason: null }] },
        { choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 3, total_tokens: 6 } },
      ]) res.write(`data: ${JSON.stringify({ id: "go-fixture", object: "chat.completion.chunk", model: body.model, ...chunk })}\n\n`);
      return res.end("data: [DONE]\n\n");
    }
    return reply(200, { id: "go-fixture", object: "chat.completion", model: body.model, choices: [{ index: 0, message: { role: "assistant", content: "Go fixture response" }, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 3, total_tokens: 6 } });
  }
  if (req.url !== "/models") return reply(404, { error: "Unknown fixture route" });
  requests.push({ authorizationPresent: Boolean(req.headers.authorization) });
  if (mode === "error") return reply(503, { error: { message: "Fixture catalog unavailable" } });
  if (mode === "malformed") return reply(200, { message: "Not a model catalog" });
  const ids = mode === "empty" ? [] : ["kimi-k3", "deepseek-v4.1-flash", "minimax-m3"];
  reply(200, { object: "list", data: ids.map((id) => ({ id, object: "model", owned_by: "opencode" })) });
}).listen(port, "127.0.0.1", () => console.log(`Go catalog mock ready: http://127.0.0.1:${port}`));
