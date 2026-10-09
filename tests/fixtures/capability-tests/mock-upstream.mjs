import http from "node:http";
import { inflateSync } from "node:zlib";
const port = Number(process.env.MOCK_PORT || 9027);
const requests = [];
function pngColors(uri) {
  const bytes = Buffer.from(uri.split(",")[1], "base64");
  let offset = 8, pixels;
  while (offset < bytes.length) {
    const length = bytes.readUInt32BE(offset);
    if (bytes.toString("ascii", offset + 4, offset + 8) === "IDAT") pixels = inflateSync(bytes.subarray(offset + 8, offset + 8 + length));
    offset += length + 12;
  }
  const colors = { "240,20,20": "red", "20,40,240": "blue", "20,180,20": "green", "240,220,20": "yellow" };
  return [colors[[...pixels.subarray(1, 4)].join(",")], colors[[...pixels.subarray(1 + 64 * 3, 4 + 64 * 3)].join(",")]].join(",");
}
http.createServer(async (req, res) => {
  const reply = (status, json) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(json)); };
  if (req.url === "/requests") return reply(200, { requests });
  if (req.url.endsWith("/models")) return reply(200, { data: [{ id: "probe-model" }, { id: "slow-model" }] });
  if (!req.url.endsWith("/chat/completions")) return reply(404, { error: { message: "No mock route" } });
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw);
  const key = req.headers.authorization;
  requests.push({ model: body.model, key, media: JSON.stringify(body.messages).includes("image_url") });
  const message = body.messages?.[0];
  const blocks = Array.isArray(message?.content) ? message.content : [];
  const text = typeof message?.content === "string" ? message.content : blocks.find((block) => block.type === "text")?.text || "";
  const image = blocks.find((block) => block.type === "image_url");
  const file = blocks.find((block) => block.type === "file");
  if (image && key === "Bearer sk-text-only") return reply(400, { error: { message: "This model does not support image input", type: "invalid_request_error" } });
  if (text.length > 20000) return reply(400, { error: { message: "maximum context length is 12000 tokens", type: "invalid_request_error" } });
  let content = text.match(/exactly ([a-f0-9]+)/)?.[1] || "hello";
  let toolCalls;
  if (image) content = pngColors(image.image_url.url);
  if (file) content = Buffer.from(file.file.file_data.split(",")[1], "base64").toString().match(/Document code: ([a-f0-9]+)/)?.[1];
  if (text.includes("BEGIN_CODE=")) content = ["BEGIN", "MIDDLE", "END"].map((position) => text.match(new RegExp(`${position}_CODE=([a-f0-9]+)`))?.[1]).join(",");
  if (body.tools?.length) toolCalls = [{ id: "call_probe", type: "function", function: { name: "capability_echo", arguments: JSON.stringify({ code: text.match(/code ([a-f0-9]+)/)?.[1] }) } }];
  if (body.response_format) content = JSON.stringify({ code: text.match(/equal to ([a-f0-9]+)/)?.[1] });
  if (body.model === "slow-model") await new Promise((resolve) => setTimeout(resolve, 15000));
  const response = {
    id: "probe", object: "chat.completion", model: body.model,
    choices: [{ index: 0, message: { role: "assistant", content, ...(toolCalls ? { tool_calls: toolCalls } : {}) }, finish_reason: toolCalls ? "tool_calls" : "stop" }],
    usage: { prompt_tokens: Math.ceil(text.length / 2), completion_tokens: 20, total_tokens: Math.ceil(text.length / 2) + 20 },
  };
  reply(200, response);
}).listen(port, "127.0.0.1", () => console.log(`Capability mock ready at http://127.0.0.1:${port}`));
