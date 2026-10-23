import { afterEach, describe, expect, it, vi } from "vitest";
import "../translator/registerAll.js";
import { createSSEStream } from "../../open-sse/utils/stream.js";
import { createStreamController, pipeWithDisconnect } from "../../open-sse/utils/streamHandler.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { CodexExecutor } from "../../open-sse/executors/codex.js";

vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(), updatePendingRequestTokens: vi.fn(),
  appendRequestLog: vi.fn(async () => {}), saveRequestUsage: vi.fn(async () => {}),
}));
const encoder = new TextEncoder();
const frame = data => encoder.encode(`data: ${JSON.stringify(data)}\n\n`);
const chat = (tool, finish_reason = null) => ({ choices: [{ delta: tool ? { tool_calls: [tool] } : {}, finish_reason }] });
const parsedEvents = text => text.split("\n").filter(l => l.startsWith("data: {")).map(l => JSON.parse(l.slice(6)));

afterEach(() => vi.useRealTimers());

describe("Codex done-only tool output through the SSE bridge", () => {
  it.each([FORMATS.OPENAI, FORMATS.CLAUDE, FORMATS.OPENAI_RESPONSES])("delivers arguments to %s before the turn finishes without duplication", async sourceFormat => {
    vi.useFakeTimers();
    const input = new TransformStream();
    const writer = input.writable.getWriter();
    const pending = new CodexExecutor()._peekSseTransientError(new Response(input.readable));
    const item = { type: "function_call", id: "item_1", call_id: "call_1", name: "Write", arguments: "" };
    await writer.write(frame({ type: "response.output_item.added", output_index: 0, item }));
    await vi.advanceTimersByTimeAsync(10_000);
    const args = '{"file_path":"a.js","content":"hello"}';
    await writer.write(frame({ type: "response.function_call_arguments.done", item_id: item.id, output_index: 0, arguments: args }));
    await vi.advanceTimersByTimeAsync(2_001);
    const peek = await pending;
    const transform = createSSEStream({ targetFormat: FORMATS.OPENAI_RESPONSES, sourceFormat, provider: "codex", completedContentMaxChars: 0 });
    let text = "";
    const drain = (async () => {
      const reader = peek.replacementBody.pipeThrough(transform).getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
      }
    })();
    await vi.advanceTimersByTimeAsync(0);
    const deltas = value => parsedEvents(value).flatMap(event => sourceFormat === FORMATS.CLAUDE
      ? [event.delta?.partial_json || ""]
      : sourceFormat === FORMATS.OPENAI
        ? (event.choices?.[0]?.delta?.tool_calls || []).map(tool => tool.function?.arguments || "")
        : [event.type === "response.function_call_arguments.done" ? event.arguments : ""]);
    expect(deltas(text).join("")).toBe(args);
    await writer.write(frame({ type: "response.output_item.done", output_index: 0, item: { ...item, arguments: args } }));
    await writer.write(frame({ type: "response.completed", response: { status: "completed" } }));
    await writer.close(); await drain;
    expect(deltas(text).join("")).toBe(args);
    expect(vi.getTimerCount()).toBe(0);
  });
});

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
