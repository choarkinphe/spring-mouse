import { afterEach, describe, expect, it, vi } from "vitest";
import "../translator/registerAll.js";
import { createSSEStream } from "../../open-sse/utils/stream.js";
import { createStreamController, pipeWithDisconnect } from "../../open-sse/utils/streamHandler.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(), updatePendingRequestTokens: vi.fn(),
  appendRequestLog: vi.fn(async () => {}), saveRequestUsage: vi.fn(async () => {}),
}));
const encoder = new TextEncoder();
const frame = data => encoder.encode(`data: ${JSON.stringify(data)}\n\n`);
const chat = (tool, finish_reason = null) => ({ choices: [{ delta: tool ? { tool_calls: [tool] } : {}, finish_reason }] });
const parsedEvents = text => text.split("\n").filter(l => l.startsWith("data: {")).map(l => JSON.parse(l.slice(6)));

afterEach(() => vi.useRealTimers());

describe("large tool calls remain streaming through the real Claude bridge", () => {
  it.each([FORMATS.OPENAI, FORMATS.OPENAI_RESPONSES])("forwards %s arguments before finish and survives 270 seconds of healthy generation", async targetFormat => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    let upstream;
    const errors = vi.fn();
    const control = createStreamController({ onError: errors, log: { line() {}, errorLine() {} } });
    const transform = createSSEStream({ targetFormat, sourceFormat: FORMATS.CLAUDE, provider: "fixture", completedContentMaxChars: 0 });
    const input = new TransformStream();
    upstream = input.writable.getWriter();
    const output = pipeWithDisconnect(new Response(input.readable), transform, control);
    let text = "";
    const drain = (async () => { const reader = output.getReader(); const decoder = new TextDecoder(); while (true) { const r = await reader.read(); if (r.done) break; text += decoder.decode(r.value, { stream: true }); } })();
    const responses = targetFormat === FORMATS.OPENAI_RESPONSES;
    await upstream.write(frame(responses
      ? { type: "response.output_item.added", output_index: 0, item: { type: "function_call", id: "item_1", call_id: "call_1", name: "Write", arguments: "" } }
      : chat({ index: 0, id: "call_1", function: { name: "Write", arguments: "" } })));
    const fragments = ['{"file_path":"a.js","content":"', ...Array(7).fill("大文件代码".repeat(100)), '"}'];
    for (const fragment of fragments) {
      await vi.advanceTimersByTimeAsync(30000);
      await upstream.write(frame(responses
        ? { type: "response.function_call_arguments.delta", item_id: "item_1", output_index: 0, delta: fragment }
        : chat({ index: 0, function: { arguments: fragment } })));
      await vi.advanceTimersByTimeAsync(0);
      const deltas = parsedEvents(text).filter(e => e.delta?.type === "input_json_delta");
      expect(deltas.at(-1)?.delta.partial_json).toBe(fragment);
      expect(control.signal.aborted).toBe(false);
    }
    const expected = fragments.join("");
    if (responses) {
      await upstream.write(frame({ type: "response.function_call_arguments.done", item_id: "item_1", output_index: 0, arguments: expected }));
      await upstream.write(frame({ type: "response.output_item.done", output_index: 0, item: { type: "function_call", id: "item_1", call_id: "call_1", name: "Write", arguments: expected } }));
      await upstream.write(frame({ type: "response.completed", response: { status: "completed" } }));
    } else await upstream.write(frame(chat(null, "tool_calls")));
    await upstream.close(); await drain;
    const events = parsedEvents(text);
    expect(events.filter(e => e.delta?.type === "input_json_delta").map(e => e.delta.partial_json).join("")).toBe(expected);
    expect(events.filter(e => e.type === "content_block_stop")).toHaveLength(1);
    expect(events.filter(e => e.type === "message_stop")).toHaveLength(1);
    expect(errors).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
