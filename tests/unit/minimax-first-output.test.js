import { afterEach, describe, expect, it, vi } from "vitest";

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: (...args) => fetchMock(...args) }));
vi.mock("@/lib/usageDb.js", () => ({
  saveRequestUsage: vi.fn(async () => {}), saveRequestDetail: vi.fn(async () => {}),
  appendRequestLog: vi.fn(async () => {}), trackPendingRequest: vi.fn(), updatePendingRequestTokens: vi.fn(),
}));
import { getExecutor } from "../../open-sse/executors/index.js";
import { handleChatCore } from "../../open-sse/handlers/chatCore.js";
import "../translator/registerAll.js";

const encoder = new TextEncoder();
const event = (data) => `event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`;
const start = event({ type: "message_start", message: { id: "msg_test", role: "assistant", content: [], usage: { input_tokens: 3 } } });
const text = event({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "synthetic" } });
const stop = event({ type: "message_stop" });
const args = (extra = {}) => ({ model: "synthetic", body: { messages: [{ role: "user", content: "synthetic" }] }, stream: true, credentials: { apiKey: "test-key" }, ...extra });
function source(prefix = "") {
  let controller;
  const cancel = vi.fn();
  return { response: new Response(new ReadableStream({ start(c) { controller = c; if (prefix) c.enqueue(encoder.encode(prefix)); }, cancel }, { highWaterMark: 0 }), { headers: { "content-type": "text/event-stream" } }),
    cancel, send(s) { controller.enqueue(encoder.encode(s)); }, close() { controller.close(); } };
}
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); fetchMock.mockReset(); });

describe.each(["minimax", "minimax-cn"])("%s first-output admission", (provider) => {
  it.each(["", start, '{"message":"upstream unavailable"}'])("rejects HTTP 200 with no output before returning a streaming success", async (preamble) => {
    fetchMock.mockResolvedValueOnce(new Response(preamble));
    const result = await getExecutor(provider).execute(args());
    expect(result.response.status).toBe(502);
    expect(result.response.__smUpstreamError.status).toBe(200);
    expect(result.response.__smUpstreamError.diagnostics).toMatchObject({ kind: "empty_output", parsed: false });
    expect(fetchMock).toHaveBeenCalledOnce();
  });
  it("ignores metadata/heartbeat and replays the exact Claude bytes", async () => {
    const prefix = start + event({ type: "ping" }) + event({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
    const src = source(prefix); fetchMock.mockResolvedValueOnce(src.response);
    let resolved = false;
    const work = getExecutor(provider).execute(args()).then(r => { resolved = true; return r; });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    expect(resolved).toBe(false);
    src.send(text + stop); src.close();
    expect(await (await work).response.text()).toBe(prefix + text + stop);
  });
  it("keeps an accepted tool stream alive beyond the routing deadline", async () => {
    vi.useFakeTimers();
    const tool = event({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tool_test", name: "synthetic", input: {} } });
    const src = source(start + tool); fetchMock.mockResolvedValueOnce(src.response);
    const result = await getExecutor(provider).execute(args({ overloadDeadline: Date.now() + 1000 }));
    await vi.advanceTimersByTimeAsync(400000);
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(false);
    src.send(stop); src.close();
    expect(await result.response.text()).toBe(start + tool + stop);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("bounds silence and releases the upstream for router fallback", async () => {
    vi.useFakeTimers(); const src = source(start); fetchMock.mockResolvedValueOnce(src.response);
    const work = getExecutor(provider).execute(args({ hasFallback: true, overloadDeadline: Date.now() + 1000 }));
    await vi.advanceTimersByTimeAsync(500);
    const result = await work;
    expect(result.response.status).toBe(503);
    expect(result.response.__smUpstreamError.origin).toBe("sse_first_output_timeout");
    expect(src.cancel).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
  });
  it("preserves an in-stream rate limit and the Retry-After evidence", async () => {
    const payload = { type: "error", error: { type: "rate_limit_error", message: "synthetic throttle" } };
    fetchMock.mockResolvedValueOnce(new Response(event(payload), { headers: { "retry-after": "12" } }));
    const result = await getExecutor(provider).execute(args());
    expect(result.response.status).toBe(429);
    expect(result.response.__smUpstreamError).toMatchObject({ status: 200, retryAfterMs: 12000 });
    expect(result.response.__smUpstreamError.diagnostics).toMatchObject({ kind: "upstream_error", type: "rate_limit_error" });
  });
  it("uses OpenAI parsing when the selected runtime transport is OpenAI", async () => {
    const payload = 'data: {"choices":[{"delta":{"content":"synthetic"}}]}\n\ndata: [DONE]\n\n';
    fetchMock.mockResolvedValueOnce(new Response(payload));
    const result = await getExecutor(provider).execute(args({ credentials: { apiKey: "test-key", runtimeTransport: { format: "openai", baseUrl: "https://synthetic.invalid/chat/completions" } } }));
    expect(result.response.status).toBe(200); expect(await result.response.text()).toBe(payload);
  });
  it("leaves a non-streaming Message unchanged", async () => {
    const body = JSON.stringify({ type: "message", content: [{ type: "text", text: "synthetic" }] });
    fetchMock.mockResolvedValueOnce(new Response(body, { headers: { "content-type": "application/json" } }));
    expect(await (await getExecutor(provider).execute(args({ stream: false }))).response.text()).toBe(body);
  });
  it("accepts a valid final Claude event without a trailing newline", async () => {
    const payload = start + stop.trimEnd();
    fetchMock.mockResolvedValueOnce(new Response(payload));
    const result = await getExecutor(provider).execute(args());
    expect(result.response.status).toBe(200); expect(await result.response.text()).toBe(payload);
  });
  it("releases on thinking and never retries an error after output", async () => {
    const thinking = event({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "synthetic" } });
    const src = source(thinking); fetchMock.mockResolvedValueOnce(src.response);
    const result = await getExecutor(provider).execute(args());
    const failure = event({ type: "error", error: { type: "api_error", message: "synthetic failure" } });
    src.send(failure); src.close();
    expect(result.response.status).toBe(200);
    expect(await result.response.text()).toBe(thinking + failure);
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

it("returns a retryable chatCore failure instead of committing an empty Claude HTTP 200", async () => {
  fetchMock.mockResolvedValueOnce(new Response(start));
  const body = { model: "synthetic", messages: [{ role: "user", content: "synthetic" }], stream: true };
  const result = await handleChatCore({
    body, modelInfo: { provider: "minimax-cn", model: "synthetic" }, credentials: { apiKey: "test-key" },
    requestId: "synthetic-minimax-empty", sourceFormatOverride: "claude",
    clientRawRequest: { endpoint: "/v1/messages", body, headers: {} },
    log: { debug() {}, info() {}, warn() {}, error() {}, line() {}, errorLine() {} },
    requestLogFileDumpsEnabled: false,
  });
  expect(result.success).toBe(false); expect(result.status).toBe(502);
  expect(result.streaming).not.toBe(true); expect(result.upstreamError.status).toBe(200);
});
