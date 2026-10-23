import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexExecutor } from "../../open-sse/executors/codex.js";

const encoder = new TextEncoder();
const frame = (data, dataOnly = false) => `${dataOnly ? "" : `event: ${data.type}\n`}data: ${JSON.stringify(data)}\n\n`;
const completed = { type: "response.completed", response: { status: "completed" } };
const toolOutputs = [
  { type: "response.function_call_arguments.done", arguments: '{"command":"pwd"}' },
  { type: "response.custom_tool_call_input.done", input: "pwd" },
  { type: "response.output_item.done", item: { type: "function_call", arguments: '{"command":"pwd"}' } },
  { type: "response.output_item.done", item: { type: "custom_tool_call", input: "pwd" } },
];

function fixture(prefix) {
  let source;
  const cancel = vi.fn();
  const response = new Response(new ReadableStream({
    start(controller) { source = controller; controller.enqueue(encoder.encode(prefix)); },
    cancel,
  }));
  return { source, response, cancel };
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("Codex tool output without deltas", () => {
  it.each(toolOutputs.flatMap(output => [false, true].map(dataOnly => ({ output, dataOnly }))))(
    "releases $output.type (data-only=$dataOnly) before the response terminal",
    async ({ output, dataOnly }) => {
      vi.useFakeTimers();
      const prefix = frame({ type: "response.created", response: {} });
      const { source, response, cancel } = fixture(prefix);
      const log = { errorLine: vi.fn() };
      const pending = new CodexExecutor()._peekSseTransientError(response, Infinity, log);
      await vi.advanceTimersByTimeAsync(10_000);
      const text = frame(output, dataOnly);
      source.enqueue(encoder.encode(text));
      await vi.advanceTimersByTimeAsync(2_001);
      const releasedBeforeTerminal = log.errorLine.mock.calls.length > 0;
      source.enqueue(encoder.encode(frame(completed)));
      source.close();
      const result = await pending;
      expect(releasedBeforeTerminal).toBe(true);
      expect(result).toMatchObject({ matched: null, stoppedOnDeadline: false });
      const record = JSON.parse(log.errorLine.mock.calls.at(-1)[2].split("CODEX-SCAN | ")[1]);
      expect(record).toMatchObject({
        outputDetected: true, firstOutputType: output.type, releaseReason: "output-grace",
        firstOutputAfterMs: 10_000, recognizedEventSeen: true, candidateWithoutDetection: false,
      });
      expect(await new Response(result.replacementBody).text()).toBe(prefix + text + frame(completed));
      expect(cancel).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("releases sufficient done-only output across split CRLF and UTF-8 chunks immediately", async () => {
    vi.useFakeTimers();
    const text = frame({ ...toolOutputs[0], arguments: JSON.stringify({ value: "\u5de5\u5177".repeat(120) }) }).replaceAll("\n", "\r\n");
    const { source, response } = fixture("");
    const log = { errorLine: vi.fn() };
    const pending = new CodexExecutor()._peekSseTransientError(response, Infinity, log);
    const bytes = encoder.encode(text);
    for (let i = 0; i < bytes.length; i += 7) source.enqueue(bytes.slice(i, i + 7));
    await vi.advanceTimersByTimeAsync(1);
    const releasedBeforeTerminal = log.errorLine.mock.calls.length > 0;
    source.enqueue(encoder.encode(frame(completed))); source.close();
    const result = await pending;
    expect(releasedBeforeTerminal).toBe(true);
    expect(await new Response(result.replacementBody).text()).toBe(text + frame(completed));
    expect(result.scanDiagnostics.firstOutputAfterMs).not.toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["same-chunk", "delayed"])("still detects an overload following short done output (%s)", async timing => {
    vi.useFakeTimers();
    const overload = frame({ type: "error", error: { code: "server_is_overloaded", message: "Our servers are currently overloaded" } });
    const { source, response, cancel } = fixture(frame(toolOutputs[0]) + (timing === "same-chunk" ? overload : ""));
    const pending = new CodexExecutor()._peekSseTransientError(response);
    if (timing === "delayed") {
      await vi.advanceTimersByTimeAsync(300);
      source.enqueue(encoder.encode(overload));
    }
    const result = await pending;
    expect(result).toMatchObject({ matched: "server_is_overloaded", replacementBody: null });
    expect(cancel).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not count repeated argument snapshots as additional output", async () => {
    vi.useFakeTimers();
    const args = "x".repeat(120);
    const { source, response, cancel } = fixture(
      frame({ type: "response.function_call_arguments.done", arguments: args })
      + frame({ type: "response.output_item.done", item: { type: "function_call", arguments: args } }),
    );
    const pending = new CodexExecutor()._peekSseTransientError(response);
    await vi.advanceTimersByTimeAsync(300);
    source.enqueue(encoder.encode(frame({ type: "error", error: { code: "server_is_overloaded" } })));
    const result = await pending;
    expect(result).toMatchObject({ matched: "server_is_overloaded", replacementBody: null });
    expect(cancel).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    { type: "response.created", response: { arguments: "private", input: "private", type: "response.function_call_arguments.done" } },
    { type: "response.future.done", arguments: "private" },
    { type: "response.function_call_arguments.done", arguments: "" },
    { type: "response.function_call_arguments.done", arguments: { command: "private" } },
    { type: "response.output_item.done", item: { type: "reasoning", arguments: "private" } },
  ])("does not treat invalid or metadata-only $type as tool output", async output => {
    vi.useFakeTimers();
    const { response } = fixture(frame(output));
    const log = { errorLine: vi.fn() };
    const pending = new CodexExecutor()._peekSseTransientError(response, Date.now() + 100, log);
    await vi.advanceTimersByTimeAsync(101);
    const result = await pending;
    expect(result).toMatchObject({ stoppedOnDeadline: true, replacementBody: null });
    expect(result.upstreamError.scanDiagnostics.firstOutputAfterMs).toBeNull();
    expect(JSON.stringify(log.errorLine.mock.calls)).not.toContain("private");
  });
});
