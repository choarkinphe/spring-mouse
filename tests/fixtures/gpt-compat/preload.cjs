require("../claude-desktop-smoke/preload.cjs");
const guardedFetch = globalThis.fetch;
globalThis.fetch = function gptCompatFetch(input, init) {
  const raw = input instanceof URL ? input.href : typeof input === "string" ? input : input?.url;
  let url;
  try { url = new URL(raw); } catch { return guardedFetch(input, init); }
  const isResponses = url.href === "https://api.openai.com/v1/responses";
  const isChat = url.href === "https://api.openai.com/v1/chat/completions";
  const isCodex = url.href === "https://chatgpt.com/backend-api/codex/responses";
  if (!isResponses && !isChat && !isCodex) return guardedFetch(input, init);
  const body = JSON.parse(init?.body || "{}");
  if (body.previous_response_id || body.conversation) return Promise.reject(new Error("Unbound state reached fixture upstream"));
  if (isResponses && (body.messages || body.reasoning_effort || body.stream_options || body.max_tokens)) return Promise.reject(new Error("Chat fields reached Responses upstream"));
  if (isChat && /^o\d/.test(body.model) && body.max_tokens !== undefined) return Promise.reject(new Error("Legacy token limit reached reasoning model"));
  const echo = JSON.stringify({ endpoint: url.pathname, body, realProviderCalled: false });
  console.log(`[gpt-compat] synthetic ${url.pathname} stream=${body.stream === true}`);
  if (isChat) {
    const response = { id: "chatcmpl-fixture", object: "chat.completion", model: body.model,
      choices: [{ index: 0, message: { role: "assistant", content: echo }, finish_reason: "stop" }],
      usage: { prompt_tokens: 2, completion_tokens: 4, total_tokens: 6 } };
    if (!body.stream) return Promise.resolve(Response.json(response));
    return Promise.resolve(new Response(`data: ${JSON.stringify({ ...response, object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: echo }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ ...response, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } }));
  }
  const response = { id: "resp_fixture", object: "response", model: body.model, status: "completed",
    output: [{ id: "msg_fixture", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: echo, annotations: [] }] }],
    usage: { input_tokens: 2, output_tokens: 4, total_tokens: 6 } };
  if (!body.stream) return Promise.resolve(Response.json(response));
  const frame = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
  return Promise.resolve(new Response(
    frame("response.created", { response: { ...response, status: "in_progress", output: [] } })
    + frame("response.output_item.added", { output_index: 0, item: { ...response.output[0], content: [] } })
    + frame("response.content_part.added", { output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } })
    + frame("response.output_text.delta", { output_index: 0, content_index: 0, delta: echo })
    + frame("response.output_text.done", { output_index: 0, content_index: 0, text: echo })
    + frame("response.output_item.done", { output_index: 0, item: response.output[0] })
    + frame("response.completed", { response }),
    { headers: { "content-type": "text/event-stream" } },
  ));
};
