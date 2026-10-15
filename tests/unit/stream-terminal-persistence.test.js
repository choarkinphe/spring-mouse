import { beforeEach, describe, expect, it, vi } from "vitest";
const { execute } = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("../../open-sse/executors/index.js", () => ({ getExecutor: () => ({ execute }) }));

vi.mock("@/lib/usageDb.js", () => ({
  saveRequestUsage: vi.fn(async () => {}), saveRequestDetail: vi.fn(async () => {}),
  appendRequestLog: vi.fn(async () => {}), trackPendingRequest: vi.fn(), updatePendingRequestTokens: vi.fn(),
}));
import { saveRequestUsage, saveRequestDetail } from "@/lib/usageDb.js";
import { handleStreamingResponse, buildOnStreamComplete } from "../../open-sse/handlers/chatCore/streamingHandler.js";
import { createStreamController } from "../../open-sse/utils/streamHandler.js";
import "../translator/registerAll.js";
import { handleChatCore } from "../../open-sse/handlers/chatCore.js";

beforeEach(() => vi.clearAllMocks());

async function drive(text, { format = "openai-responses", targetFormat = format, observed = true } = {}) {
  const onRequestSuccess = vi.fn();
  const ctx = {
    provider: "probe", model: "probe", requestId: "req", requestStartTime: Date.now(),
    body: {}, stream: true, clientRawRequest: {}, observabilityEnabled: observed,
    observabilityMaxJsonChars: 1024, sourceFormat: format, targetFormat,
    onRequestSuccess, log: {},
    providerResponse: new Response(text, { headers: { "content-type": "text/event-stream" } }),
    streamController: createStreamController({}),
  };
  const completion = buildOnStreamComplete(ctx);
  const result = await handleStreamingResponse({ ...ctx, ...completion });
  // A 200 header is not evidence of success, even when the stream is lazy.
  await Promise.resolve();
  expect(onRequestSuccess).not.toHaveBeenCalled();
  if (observed) expect(saveRequestDetail.mock.calls[0][0].status).toBe("pending");
  const output = await result.response.text();
  await Promise.resolve();
  return { onRequestSuccess, completion, output };
}

describe("stream usage follows the actual protocol terminal", () => {
  it.each([true, false])("records a failed HTTP 200 stream with details=%s", async (observed) => {
    const { onRequestSuccess } = await drive('event: error\ndata: {"type":"error","error":{"code":"new_failure","message":"failed"}}\n\n', { observed });
    expect(saveRequestUsage).toHaveBeenCalledOnce();
    expect(saveRequestUsage.mock.calls[0][0].status).toBe("error");
    expect(onRequestSuccess).not.toHaveBeenCalled();
    if (observed) expect(saveRequestDetail.mock.calls.at(-1)[0]).toMatchObject({ status: "error", response: { terminalReason: "upstream_error" } });
  });
  it.each([
    ["openai-responses", 'event: response.failed\ndata: {"response":{"status":"failed"}}\n\n'],
    ["openai", 'data: {"error":{"code":"new_failure"}}\n\n'],
    ["claude", 'event: error\ndata: {"type":"error","error":{"type":"api_error"}}\n\n'],
  ])("keeps %s failure in passthrough mode", async (format, text) => {
    await drive(text, { format });
    expect(saveRequestUsage.mock.calls[0][0].status).toBe("error");
  });
  it("records bare EOF as incomplete instead of success", async () => {
    await drive('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n', { format: "openai" });
    expect(saveRequestUsage.mock.calls[0][0].status).toBe("error");
    expect(saveRequestDetail.mock.calls.at(-1)[0].response.terminalReason).toBe("incomplete");
  });
  it.each(["claude", "openai"])("forwards a Responses error to %s as an error, not successful text", async (format) => {
    const { output } = await drive('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"partial"}\n\nevent: error\ndata: {"type":"error","error":{"code":"upstream_failure","message":"failed"}}\n\n', { format, targetFormat: "openai-responses" });
    expect(output).toContain('"error":{');
    expect(output).not.toContain('[Error]');
    expect(output).not.toContain('"finish_reason":"stop"');
    expect(output).not.toContain('event: message_stop');
    expect(saveRequestUsage.mock.calls[0][0].status).toBe("error");
  });
  it("recognizes a final event without a trailing newline and clears account errors only afterwards", async () => {
    const { onRequestSuccess, completion } = await drive('event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":3,"output_tokens":1}}}');
    expect(saveRequestUsage.mock.calls[0][0]).toMatchObject({ status: "success", tokens: { prompt_tokens: 3, completion_tokens: 1 } });
    expect(onRequestSuccess).toHaveBeenCalledOnce();
    // A late disconnect must not overwrite a completed result or double bill.
    completion.onStreamComplete(null, null, null, { outcome: "cancelled", terminalReason: "client_abort" });
    expect(saveRequestUsage).toHaveBeenCalledOnce();
  });
});

describe("real chatCore transport termination", () => {
  it.each(["cancelled", "error"])("finalizes usage and the pending detail on %s", async (status) => {
    let upstream;
    const response = new Response(new ReadableStream({ start(c) { upstream = c; } }), { headers: { "content-type": "text/event-stream" } });
    execute.mockResolvedValueOnce({ response });
    const body = { model: "gpt-4.1", messages: [{ role: "user", content: "synthetic" }], stream: true };
    const onRequestSuccess = vi.fn();
    const result = await handleChatCore({
      body, modelInfo: { provider: "openai", model: "gpt-4.1" }, credentials: {},
      requestId: "transport-test", clientRawRequest: { endpoint: "/v1/chat/completions", body, headers: { accept: "text/event-stream" } },
      sourceFormatOverride: "openai", log: { debug() {}, info() {}, warn() {}, error() {}, line() {}, errorLine() {} },
      onRequestSuccess, requestLogFileDumpsEnabled: false,
    });
    expect(result.streaming).toBe(true);
    const reader = result.response.body.getReader();
    upstream.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"partial"}}],"usage":{"prompt_tokens":16,"completion_tokens":3}}\n\n'));
    await reader.read();
    if (status === "cancelled") await reader.cancel();
    else {
      upstream.error(new Error("synthetic stream failure"));
      await expect((async () => { while (!(await reader.read()).done) {} })()).rejects.toThrow("synthetic stream failure");
    }
    expect(saveRequestUsage).toHaveBeenCalledOnce();
    expect(saveRequestUsage.mock.calls[0][0].status).toBe(status);
    expect(saveRequestUsage.mock.calls[0][0].tokens).toMatchObject({ prompt_tokens: 16, completion_tokens: 3 });
    expect(saveRequestDetail.mock.calls.at(-1)[0].status).toBe(status);
    const transport = saveRequestDetail.mock.calls.at(-1)[0].latency.streamTransport;
    expect(transport).toMatchObject({ stage: status === "cancelled" ? "client_abort" : "stream_error" });
    expect(transport.upstreamBytes).toBeGreaterThan(0);
    expect(transport.transformedBytes).toBeGreaterThan(0);
    expect(JSON.stringify(transport)).not.toContain("synthetic stream failure");
    expect(onRequestSuccess).not.toHaveBeenCalled();
  });
});

describe("terminal versus delivery races", () => {
  it.each(["openai", "claude"])("emits a protocol error for an empty %s stream", async (format) => {
    const { output, onRequestSuccess } = await drive("", { format });
    expect(output).toContain('"code":"empty_stream"');
    expect(output).not.toContain('event: message_stop');
    expect(output).not.toContain('"finish_reason":"stop"');
    expect(saveRequestDetail.mock.calls.at(-1)[0].response.terminalReason).toBe("empty_stream");
    expect(onRequestSuccess).not.toHaveBeenCalled();
  });

  it.each([
    ["openai", "openai", 'data: {"choices":[{"delta":{"content":"answer"},"finish_reason":"stop"}],"usage":{"prompt_tokens":16,"completion_tokens":8}}\n\n'],
    ["openai-responses", "openai-responses", 'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":16,"output_tokens":8}}}\n\n'],
    ["claude", "openai-responses", 'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":16,"output_tokens":8}}}\n\n'],
  ])("preserves observed terminal usage on %s client cancel before EOF (%s upstream)", async (sourceFormat, targetFormat, terminalFrame) => {
    const { createRoutingObserver } = await import("../../open-sse/utils/routingOutcome.js");
    const terminal = vi.fn();
    const observer = createRoutingObserver({ observer: { onTerminal: terminal, onCancelled: vi.fn() } });
    let upstream;
    execute.mockResolvedValueOnce({ responseFormat: targetFormat, response: new Response(new ReadableStream({ start(c) { upstream = c; } }), { headers: { "content-type": "text/event-stream" } }) });
    const body = { model: "gpt-4.1", messages: [{ role: "user", content: "synthetic" }], stream: true };
    const result = await handleChatCore({
      body, modelInfo: { provider: "openai", model: "gpt-4.1" }, credentials: {},
      requestId: "terminal-cancel", routingObserver: observer,
      clientRawRequest: { endpoint: "/v1/chat/completions", body, headers: { accept: "text/event-stream" } },
      sourceFormatOverride: sourceFormat, log: { debug() {}, info() {}, warn() {}, error() {}, line() {}, errorLine() {} },
      requestLogFileDumpsEnabled: false,
    });
    const reader = result.response.body.getReader();
    upstream.enqueue(new TextEncoder().encode(terminalFrame));
    await reader.read();
    await reader.cancel();
    expect(saveRequestUsage).toHaveBeenCalledOnce();
    expect(saveRequestUsage.mock.calls[0][0]).toMatchObject({ status: "success", tokens: { prompt_tokens: 16, completion_tokens: 8 } });
    expect(terminal).toHaveBeenCalledOnce();
    expect(terminal.mock.calls[0][0]).toMatchObject({ outcome: "valid_terminal", promptTokens: 16, completionTokens: 8 });
    expect(saveRequestDetail.mock.calls.at(-1)[0]).toMatchObject({ status: "success", response: { outcome: "valid_terminal", deliveryOutcome: "client_abort" } });
  });

  it("retains a Claude output-limit reason when message_stop follows it", async () => {
    await drive('event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"max_tokens"},"usage":{"output_tokens":1}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n', { format: "claude" });
    expect(saveRequestDetail.mock.calls.at(-1)[0]).toMatchObject({ status: "error", response: { outcome: "incomplete", terminalReason: "output_limit", deliveryOutcome: "stream_complete" } });
  });
});
