// Minimal mock upstream for the Claude Desktop smoke fixture.
//
// Speaks just enough OpenAI Chat Completions for the gateway's
// openai-compatible transport: a models list and a chat completion (stream and
// non-stream). Uses mock credentials and requires the expected translated model.
import http from "node:http";

const PORT = Number(process.env.MOCK_PORT || 9911);

function readBody(req) {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      try { resolve(JSON.parse(raw || "{}")); } catch { resolve({}); }
    });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);

  if (req.method === "GET" && url.pathname.endsWith("/models")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ object: "list", data: [{ id: "mock-model", object: "model" }] }));
    return;
  }

  if (req.method === "POST" && url.pathname.endsWith("/chat/completions")) {
    const body = await readBody(req);
    if (body.model !== "mock-model" || req.headers.authorization !== "Bearer sk-mock" || body.messages?.[0]?.role !== "user") {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Unexpected translated model, auth or messages" } }));
      return;
    }
    console.log(`[mock-upstream] accepted model=${body.model} stream=${Boolean(body.stream)}`);
    if (body.stream) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      const chunk = (delta, extra = {}) => `data: ${JSON.stringify({
        id: "chatcmpl-mock", object: "chat.completion.chunk", created: 1, model: body.model,
        choices: [{ index: 0, delta, finish_reason: null }], ...extra,
      })}\n\n`;
      res.write(chunk({ role: "assistant", content: "hello from mock" }));
      res.write(`data: ${JSON.stringify({
        id: "chatcmpl-mock", object: "chat.completion.chunk", created: 1, model: body.model,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
      })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      id: "chatcmpl-mock", object: "chat.completion", created: 1, model: body.model,
      choices: [{ index: 0, message: { role: "assistant", content: "hello from mock" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
    }));
    return;
  }

  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: { message: `no mock route for ${req.method} ${url.pathname}` } }));
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[mock-upstream] listening on http://127.0.0.1:${PORT}`);
});
