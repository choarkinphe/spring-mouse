import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(), appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}), saveRequestUsage: vi.fn(async () => {}),
}));

const { handleNonStreamingResponse } = await import("../../open-sse/handlers/chatCore/nonStreamingHandler.js");
const { FORMATS } = await import("../../open-sse/translator/formats.js");

const fixtures = [
  [FORMATS.CLAUDE, { id: "msg_test", type: "message", role: "assistant", model: "test", content: [
    { type: "tool_use", id: "call_test", name: "spring_mouse_web_search", input: { query: "release" } },
  ], stop_reason: "tool_use", usage: { input_tokens: 3, output_tokens: 2 } }],
  [FORMATS.GEMINI, { candidates: [{ content: { role: "model", parts: [
    { functionCall: { name: "spring_mouse_web_search", args: { query: "release" } } },
  ] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2, totalTokenCount: 5 } }],
];

describe("Responses JSON bridge from non-OpenAI upstreams", () => {
  it.each(fixtures)("converts %s tool calls into Responses output items", async (targetFormat, payload) => {
    const result = await handleNonStreamingResponse({
      providerResponse: Response.json(payload), targetFormat, sourceFormat: FORMATS.OPENAI_RESPONSES,
      provider: "fixture", model: "test", body: {}, requestStartTime: Date.now(),
      reqLogger: { logProviderResponse: vi.fn(), logConvertedResponse: vi.fn(), logClientResponse: vi.fn(), close: vi.fn() },
      log: {}, recordUsage: false, trackDone: vi.fn(), appendLog: vi.fn(),
      streamController: { complete: vi.fn() },
    });
    expect(result.success).toBe(true);
    const data = await result.response.json();
    expect(data.object).toBe("response");
    expect(data.output).toContainEqual(expect.objectContaining({ type: "function_call", name: "spring_mouse_web_search", arguments: '{"query":"release"}' }));
    expect(data).not.toHaveProperty("choices");
  });
});
