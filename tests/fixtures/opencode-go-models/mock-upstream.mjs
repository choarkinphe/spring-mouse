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
  if (req.url !== "/models") return reply(404, { error: "Unknown fixture route" });
  requests.push({ authorizationPresent: Boolean(req.headers.authorization) });
  if (mode === "error") return reply(503, { error: { message: "Fixture catalog unavailable" } });
  if (mode === "malformed") return reply(200, { message: "Not a model catalog" });
  const ids = mode === "empty" ? [] : ["kimi-k3", "deepseek-v4.1-flash", "minimax-m3"];
  reply(200, { object: "list", data: ids.map((id) => ({ id, object: "model", owned_by: "opencode" })) });
}).listen(port, "127.0.0.1", () => console.log(`Go catalog mock ready: http://127.0.0.1:${port}`));
