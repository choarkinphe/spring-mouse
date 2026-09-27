/**
 * A Claude client (an Anthropic-format caller) behind a FORCED-STREAMING provider
 * (Codex) is served by `handleForcedSSEToJson`, which converts the upstream
 * Responses SSE into a single JSON body.
 *
 * That path had branches for Responses, Gemini and OpenAI — but not for Claude, so
 * an Anthropic caller fell through to the OpenAI ChatCompletion shape. The client
 * rejected an otherwise valid 200 with:
 *
 *   "API returned an empty or malformed response (HTTP 200) …
 *    body is JSON but not a Message"
 *
 * This is why only the GPT channels showed it: a plain openai-format provider
 * (deepseek) never enters this path at all — its non-streaming responses take the
 * ordinary route — while every Codex (forceStream) /v1/messages request did.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/usageDb.js", () => ({
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
  saveRequestUsage: vi.fn(async () => {}),
}));

import { handleForcedSSEToJson } from "../../open-sse/handlers/chatCore/sseToJsonHandler.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

function streamFromText(text) {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) { controller.enqueue(encoder.encode(text)); controller.close(); },
  }), { headers: { "content-type": "text/event-stream" } });
}

/** A completed Responses turn that produced text. */
const TEXT_TURN = [
  "event: response.created",
  'data: {"type":"response.created","response":{"id":"resp_abc","model":"gpt-6-astra"}}',
  "",
  "event: response.output_item.added",
  'data: {"type":"response.output_item.added","output_index":0,"item":{"id":"msg_1","type":"message","role":"assistant","content":[]}}',
  "",
  "event: response.output_text.delta",
  'data: {"type":"response.output_text.delta","output_index":0,"delta":"Hello"}',
  "",
  "event: response.output_item.done",
  'data: {"type":"response.output_item.done","output_index":0,"item":{"id":"msg_1","type":"message","role":"assistant","content":[{"type":"output_text","text":"Hello"}]}}',
  "",
  "event: response.completed",
  'data: {"type":"response.completed","response":{"id":"resp_abc","status":"completed","usage":{"input_tokens":10,"output_tokens":2,"total_tokens":12}}}',
  "",
].join("\n");

/** A completed Responses turn whose answer is a tool call. */
const TOOL_TURN = [
  "event: response.created",
  'data: {"type":"response.created","response":{"id":"resp_tool","model":"gpt-6-astra"}}',
  "",
  "event: response.output_item.added",
  'data: {"type":"response.output_item.added","output_index":0,"item":{"id":"fc_1","type":"function_call","call_id":"call_1","name":"Read","arguments":""}}',
  "",
  "event: response.function_call_arguments.delta",
  'data: {"type":"response.function_call_arguments.delta","output_index":0,"delta":"{\\"file_path\\":\\"/tmp/x\\"}"}',
  "",
  "event: response.output_item.done",
  'data: {"type":"response.output_item.done","output_index":0,"item":{"id":"fc_1","type":"function_call","call_id":"call_1","name":"Read","arguments":"{\\"file_path\\":\\"/tmp/x\\"}"}}',
  "",
  "event: response.completed",
  'data: {"type":"response.completed","response":{"id":"resp_tool","status":"completed","usage":{"input_tokens":7,"output_tokens":4,"total_tokens":11}}}',
  "",
].join("\n");

function ctx(raw, sourceFormat) {
  return {
    providerResponse: streamFromText(raw),
    sourceFormat,
    targetFormat: FORMATS.OPENAI_RESPONSES,
    provider: "codex",
    model: "gpt-6-astra",
    body: { model: "gpt-6-astra", input: "hi" },
    stream: false,
    requestStartTime: Date.now(),
    connectionId: "conn-1",
    clientRawRequest: { endpoint: "/v1/messages" },
    trackDone: vi.fn(),
    appendLog: vi.fn(),
    log: {},
  };
}

describe("a Claude caller behind a forced-streaming provider gets a Message", () => {
  it("returns a Claude Message, not an OpenAI ChatCompletion", async () => {
    const result = await handleForcedSSEToJson(ctx(TEXT_TURN, FORMATS.CLAUDE));
    expect(result.success).toBe(true);
    expect(result.response.status).toBe(200);

    const body = await result.response.json();
    // The exact failure the client reported: an OpenAI ChatCompletion is valid
    // JSON but is not a Message, so the caller rejected it.
    expect(body.object).toBeUndefined();
    expect(body.type).toBe("message");
    expect(body.role).toBe("assistant");
    expect(body.content).toEqual([{ type: "text", text: "Hello" }]);
    expect(body.stop_reason).toBe("end_turn");
    expect(body.usage).toEqual({ input_tokens: 10, output_tokens: 2 });
  });

  it("maps a tool-call turn to tool_use blocks with a tool_use stop reason", async () => {
    const result = await handleForcedSSEToJson(ctx(TOOL_TURN, FORMATS.CLAUDE));
    const body = await result.response.json();

    expect(body.type).toBe("message");
    expect(body.stop_reason).toBe("tool_use");
    const block = body.content.find((c) => c.type === "tool_use");
    expect(block).toBeTruthy();
    expect(block.name).toBe("Read");
    expect(block.id).toBe("call_1");
    // The arguments arrive as a JSON string upstream and must be a parsed object.
    expect(block.input).toEqual({ file_path: "/tmp/x" });
  });

  it("still returns the OpenAI shape for a chat caller", async () => {
    // The Claude branch must not disturb the existing non-Claude callers.
    const result = await handleForcedSSEToJson(ctx(TEXT_TURN, FORMATS.OPENAI));
    const body = await result.response.json();
    expect(body.object).toBe("chat.completion");
    expect(body.choices?.[0]?.message?.content).toBe("Hello");
  });
});
