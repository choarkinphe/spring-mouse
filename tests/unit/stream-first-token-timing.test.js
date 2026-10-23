import { afterEach, describe, expect, it, vi } from "vitest";
import { createSSEStream, createPassthroughStreamWithLogger } from "../../open-sse/utils/stream.js";
import { createRoutingObserver } from "../../open-sse/utils/routingOutcome.js";
import { buildOnStreamComplete } from "../../open-sse/handlers/chatCore/streamingHandler.js";
import { saveRequestDetail } from "@/lib/usageDb.js";

vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(), updatePendingRequestTokens: vi.fn(),
  appendRequestLog: vi.fn(async () => {}), saveRequestUsage: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
}));
const encoder = new TextEncoder();
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

async function measure({ format, preamble, content, terminal }) {
  vi.useFakeTimers(); vi.setSystemTime(1000);
  const onTerminal = vi.fn(); const completed = vi.fn();
  const routing = createRoutingObserver({ observer: { onTerminal }, requestStartTime: 1000 });
  const transform = createPassthroughStreamWithLogger("fixture", null, "m", null, {}, completed, null, 0, 0, null, routing, format);
  const writer = transform.writable.getWriter();
  const drain = new Response(transform.readable).text();
  await writer.write(encoder.encode(preamble));
  vi.setSystemTime(4500);
  if (content) await writer.write(encoder.encode(content));
  vi.setSystemTime(7000);
  await writer.write(encoder.encode(terminal)); await writer.close(); await drain;
  return { completed, onTerminal };
}

describe("stream first token timing", () => {
  it.each([
    ["openai", ': ping\n\ndata: {"choices":[{"delta":{"role":"assistant"}}]}\n\n', 'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"t","function":{"name":"Write","arguments":"{"}}]}}]}\n\n', 'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n'],
    ["claude", 'data: {"type":"message_start"}\n\n', 'data: {"type":"content_block_delta","delta":{"type":"input_json_delta","partial_json":"{"}}\n\n', 'data: {"type":"message_stop"}\n\n'],
    ["gemini", ': heartbeat\n\n', 'data: {"candidates":[{"content":{"parts":[{"text":"hello"}]}}]}\n\n', 'data: {"candidates":[{"finishReason":"STOP"}]}\n\n'],
    ["openai-responses", 'data: {"type":"response.created"}\n\n', 'data: {"type":"response.function_call_arguments.done","arguments":"{}"}\n\n', 'data: {"type":"response.completed","response":{"status":"completed"}}\n\n'],
    ["openai-responses", 'data: {"type":"response.created"}\n\n', 'data: {"type":"response.custom_tool_call_input.done","input":"pwd"}\n\n', 'data: {"type":"response.completed","response":{"status":"completed"}}\n\n'],
    ["openai-responses", 'data: {"type":"response.created"}\n\n', 'data: {"type":"response.output_item.done","item":{"type":"function_call","arguments":"{}"}}\n\n', 'data: {"type":"response.completed","response":{"status":"completed"}}\n\n'],
  ])("ignores %s framing and stamps actual model output", async (format, preamble, content, terminal) => {
    const { completed, onTerminal } = await measure({ format, preamble, content, terminal });
    expect(completed.mock.calls[0][2]).toBe(4500);
    expect(onTerminal.mock.calls[0][0].ttftMs).toBe(3500);
  });

  it("leaves first token unknown when no output ever arrives", async () => {
    const { completed, onTerminal } = await measure({ format: "openai", preamble: ': ping\n\n', terminal: 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' });
    expect(completed.mock.calls[0][2]).toBeNull();
    expect(onTerminal.mock.calls[0][0].ttftMs).toBeNull();
    const { onStreamComplete } = buildOnStreamComplete({ requestStartTime: 1000, body: {}, clientRawRequest: {}, observabilityEnabled: true, observabilityMaxJsonChars: 1024, recordUsage: false });
    onStreamComplete({}, null, null);
    expect(saveRequestDetail.mock.calls.at(-1)[0].latency).toMatchObject({ ttft: null, total: 6000 });
  });

  it("records output timing when routing telemetry is disabled", async () => {
    vi.useFakeTimers(); vi.setSystemTime(1000);
    const completed = vi.fn();
    const transform = createSSEStream({ mode: "passthrough", targetFormat: "openai", onStreamComplete: completed });
    const writer = transform.writable.getWriter(); const drain = new Response(transform.readable).text();
    await writer.write(encoder.encode(': ping\n\n')); vi.setSystemTime(2000);
    await writer.write(encoder.encode('data: {"choices":[{"delta":{"content":"yes"}}]}\n\n'));
    await writer.close(); await drain;
    expect(completed.mock.calls[0][2]).toBe(2000);
  });
});
