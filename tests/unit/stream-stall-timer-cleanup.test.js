import { afterEach, describe, expect, it, vi } from "vitest";

import { pipeWithDisconnect } from "../../open-sse/utils/streamHandler.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("stream stall watchdog cleanup", () => {
  it("clears the watchdog after a normally completed stream", async () => {
    vi.useFakeTimers();
    const abort = vi.fn();
    const handleComplete = vi.fn();
    const streamController = {
      signal: new AbortController().signal,
      startTime: Date.now(),
      isConnected: () => true,
      handleComplete,
      handleError: vi.fn(),
      handleDisconnect: vi.fn(),
      abort,
    };
    const providerResponse = new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("data: ok\n\n"));
        controller.close();
      },
    }));
    const output = pipeWithDisconnect(
      providerResponse,
      new TransformStream(),
      streamController,
      null,
      5_000,
    );

    const reader = output.getReader();
    while (!(await reader.read()).done) {}

    expect(handleComplete).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(abort).not.toHaveBeenCalled();
  });
});

function stalledPipe(timeout = 5000) {
  const abortController = new AbortController();
  let source;
  const response = new Response(new ReadableStream({ start(c) { source = c; } }));
  abortController.signal.addEventListener("abort", () => { try { source.error(new DOMException("aborted", "AbortError")); } catch {} });
  const control = {
    signal: abortController.signal, startTime: Date.now(), isConnected: () => !abortController.signal.aborted,
    handleComplete: vi.fn(), handleError: vi.fn(), handleDisconnect: vi.fn(), abort: vi.fn(() => abortController.abort()),
  };
  return { control, source, output: pipeWithDisconnect(response, new TransformStream(), control, null, timeout) };
}
it("continues watching when the upstream never sends its first byte", async () => {
  vi.useFakeTimers();
  const { control, output } = stalledPipe();
  const consume = new Response(output).text().catch(() => "aborted");
  await vi.advanceTimersByTimeAsync(6000); await consume;
  expect(control.abort).toHaveBeenCalledOnce();
  expect(control.handleError.mock.calls.some(([e]) => e.message === "stream stall timeout")).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});
it("does not allocate a new watchdog for every token", async () => {
  vi.useFakeTimers();
  const timeout = vi.spyOn(globalThis, "setTimeout");
  const { source, output } = stalledPipe();
  const consume = new Response(output).text();
  for (let i = 0; i < 100; i++) source.enqueue(new TextEncoder().encode("x"));
  source.close(); expect((await consume).length).toBe(100);
  expect(timeout).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
  timeout.mockRestore();
});
it("clears the watchdog on downstream cancellation", async () => {
  vi.useFakeTimers();
  const { output, control } = stalledPipe();
  await output.cancel("window closed");
  expect(control.handleDisconnect).toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
});
