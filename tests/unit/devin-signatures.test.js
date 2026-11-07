import { describe, expect, it, vi } from "vitest";
vi.mock("@/lib/usageDb.js", () => ({
  saveRequestDetail: vi.fn(async () => {}), appendRequestLog: vi.fn(async () => {}),
  saveRequestUsage: vi.fn(async () => {}),
}));
vi.mock("../../open-sse/handlers/chatCore/requestDetail.js", () => ({
  buildRequestDetail: vi.fn(() => ({})), extractRequestConfig: vi.fn(() => ({})),
  saveUsageStats: vi.fn(), formatDoneLine: vi.fn(() => ""),
}));
import { FORMATS } from "../../open-sse/translator/formats.js";
import { initState } from "../../open-sse/translator/index.js";
import { openaiToClaudeResponse } from "../../open-sse/translator/response/openai-to-claude.js";
import { parseSSEToOpenAIResponse, handleForcedSSEToJson } from "../../open-sse/handlers/chatCore/sseToJsonHandler.js";

const signature = "opaque\u0000provider/signature+==";

const chunk = (delta, finish_reason = null, usage) => ({
  id: "chatcmpl-signature-fixture", model: "swe-2-high",
  choices: [{ index: 0, delta, finish_reason }], ...(usage ? { usage } : {}),
});
function claudeEvents(provider, chunks) {
  const state = { ...initState(FORMATS.CLAUDE), provider, messageStartSent: false, nextBlockIndex: 0,
    toolCalls: new Map(), usage: null };
  return chunks.flatMap((item) => openaiToClaudeResponse(item, state) || []);
}
function parse(chunks) {
  return parseSSEToOpenAIResponse(chunks.map(data => `data: ${JSON.stringify(data)}\n\n`).join("") + "data: [DONE]\n\n", "swe-2-high");
}

describe("Devin reasoning signatures", () => {
  it("holds Claude thinking open until trailing opaque signature, then flushes text", () => {
    const events = claudeEvents("devin", [
      chunk({ reasoning_content: "private reasoning" }),
      chunk({ content: "answer" }),
      chunk({ reasoning_signature: signature, reasoning_signature_type: "anthropic" }),
      chunk({}, "stop"),
    ]);
    const starts = events.filter(event => event.type === "content_block_start");
    const thinking = starts.find(event => event.content_block.type === "thinking");
    expect(thinking.content_block).toEqual({ type: "thinking", thinking: "" });
    const sig = events.find(event => event.delta?.type === "signature_delta");
    expect(sig).toEqual({ type: "content_block_delta", index: thinking.index, delta: { type: "signature_delta", signature } });
    const textStart = starts.find(event => event.content_block.type === "text");
    expect(textStart).toBeTruthy();
    expect(events.findIndex(event => event === sig)).toBeLessThan(events.findIndex(event => event === textStart));
    expect(events.at(-1).type).toBe("message_stop");
  });

  it("attaches trailing signature before deferred tools and preserves streamed cache read/write counts", () => {
    const events = claudeEvents("devin", [
      chunk({ reasoning_content: "thinking" }),
      chunk({ tool_calls: [{ index: 0, id: "tool-1", function: { name: "lookup", arguments: '{"q":1}' } }] }),
      chunk({ reasoning_signature: signature }),
      chunk({}, "tool_calls", { prompt_tokens: 120, completion_tokens: 4,
        prompt_tokens_details: { cached_tokens: 80, cache_write_tokens: 20 } }),
    ]);
    expect(events.filter(event => event.content_block?.type === "thinking")).toHaveLength(1);
    const sigIndex = events.findIndex(event => event.delta?.type === "signature_delta");
    const toolIndex = events.findIndex(event => event.content_block?.type === "tool_use");
    expect(sigIndex).toBeLessThan(toolIndex);
    expect(events.find(event => event.type === "message_delta")).toMatchObject({ delta: { stop_reason: "tool_use" },
      usage: { input_tokens: 20, output_tokens: 4, cache_read_input_tokens: 80, cache_creation_input_tokens: 20 } });
  });

  it("forwards original signature without inventing one for other providers", () => {
    const withSignature = claudeEvents("devin", [
      chunk({ reasoning_content: "thinking" }), chunk({ reasoning_signature: signature }), chunk({}, "stop"),
    ]);
    expect(withSignature.find(event => event.delta?.type === "signature_delta")?.delta.signature).toBe(signature);

    const other = claudeEvents("openai", [chunk({ reasoning_content: "thinking" }), chunk({ content: "answer" }), chunk({}, "stop")]);
    expect(other.some(event => event.delta?.type === "signature_delta")).toBe(false);
    expect(other.find(event => event.type === "content_block_start" && event.content_block.type === "text")).toBeTruthy();
  });

  it("flushes deferred Devin text/tool output if the stream finishes without signature", () => {
    const events = claudeEvents("devin", [
      chunk({ reasoning_content: "thinking" }), chunk({ content: "answer" }), chunk({}, "stop"),
    ]);
    expect(events.some(event => event.delta?.type === "signature_delta")).toBe(false);
    expect(events.find(event => event.delta?.text === "answer")).toBeTruthy();
    expect(events.at(-1).type).toBe("message_stop");
  });

  it("round-trips opaque signature into non-stream Claude thinking block and keeps cache usage", async () => {
    const parsed = parse([
      chunk({ reasoning_content: "private reasoning" }),
      chunk({ reasoning_signature: signature, reasoning_signature_type: "anthropic" }),
      chunk({ content: "answer" }),
      chunk({}, "stop", { prompt_tokens: 120, completion_tokens: 4, total_tokens: 124,
        prompt_tokens_details: { cached_tokens: 80, cache_write_tokens: 20 } }),
    ]);
    expect(parsed.choices[0].message).toMatchObject({ reasoning_content: "private reasoning", reasoning_signature: signature, reasoning_signature_type: "anthropic" });
    expect(parsed.usage).toMatchObject({ prompt_tokens: 120, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 80, cache_write_tokens: 20 } });
    const raw = [
      chunk({ reasoning_content: "private reasoning" }),
      chunk({ reasoning_signature: signature, reasoning_signature_type: "anthropic" }),
      chunk({ content: "answer" }),
      chunk({}, "stop", { prompt_tokens: 120, completion_tokens: 4, total_tokens: 124,
        prompt_tokens_details: { cached_tokens: 80, cache_write_tokens: 20 } }),
    ].map(data => `data: ${JSON.stringify(data)}\n\n`).join("") + "data: [DONE]\n\n";
    const response = new Response(raw, { headers: { "content-type": "text/event-stream" } });
    const result = await handleForcedSSEToJson({
      providerResponse: response, sourceFormat: FORMATS.CLAUDE, targetFormat: FORMATS.OPENAI,
      provider: "devin", model: "swe-2-high", body: { model: "swe-2-high" }, stream: false,
      requestStartTime: Date.now(), trackDone: vi.fn(), appendLog: vi.fn(), log: {}, recordUsage: false,
    });
    const message = await result.response.json();
    expect(message.content).toEqual([
      { type: "thinking", thinking: "private reasoning", signature },
      { type: "text", text: "answer" },
    ]);
    expect(message.usage).toEqual({ input_tokens: 20, output_tokens: 4, cache_read_input_tokens: 80, cache_creation_input_tokens: 20 });
  });
});
