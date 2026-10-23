import { afterEach, describe, expect, it, vi } from "vitest";

import { createStreamController, pipeWithDisconnect } from "../../open-sse/utils/streamHandler.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("stream stall watchdog cleanup", () => {
  it("aborts upstream on processing failure and settles once", () => {
    const onError = vi.fn();
    const onDisconnect = vi.fn();
    const client = new AbortController();
    const control = createStreamController({ clientSignal: client.signal, onError, onDisconnect, log: { errorLine() {} } });
    const error = new Error("translator failed");
    control.handleError(error);
    expect(control.signal.aborted).toBe(true);
    expect(control.signal.reason).toBe(error);
    client.abort(); control.handleError(error);
    expect(onError).toHaveBeenCalledOnce();
    expect(onDisconnect).not.toHaveBeenCalled();
  });
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

it.each(["visible_stall", "upstream_stall"])("captures %s byte evidence before error settlement", async (stage) => {
  vi.useFakeTimers();
  let upstream;
  const onSnapshot = vi.fn();
  const onError = vi.fn(() => expect(onSnapshot).toHaveBeenCalledOnce());
  const control = createStreamController({ onError, log: { errorLine() {} } });
  const response = new Response(new ReadableStream({ start(c) { upstream = c; } }));
  control.signal.addEventListener("abort", () => upstream.error(new DOMException("aborted", "AbortError")));
  const transform = new TransformStream({ transform(chunk, c) { if (chunk[0] !== 0) c.enqueue(chunk); } });
  const output = pipeWithDisconnect(response, transform, control, null,
    stage === "upstream_stall" ? 5000 : 10000, { onSnapshot }, stage === "visible_stall" ? 5000 : 10000);
  const consuming = new Response(output).arrayBuffer();
  upstream.enqueue(new Uint8Array([1, 2]));
  await vi.advanceTimersByTimeAsync(4000);
  if (stage === "visible_stall") upstream.enqueue(new Uint8Array([0, 3, 4]));
  await vi.advanceTimersByTimeAsync(2000);
  await consuming;
  expect(onError).toHaveBeenCalledOnce();
  expect(onSnapshot.mock.calls[0][0]).toMatchObject({
    stage, upstreamBytes: stage === "visible_stall" ? 5 : 2,
    transformedBytes: 2, transformedIdleMs: 6000,
  });
  expect(vi.getTimerCount()).toBe(0);
});

it.each([
  { cause: "upstream_active_client_silent", sendUpstreamBytes: true, expectedBytesAfterOutput: 3 },
  { cause: "upstream_idle_client_silent", sendUpstreamBytes: false, expectedBytesAfterOutput: 0 },
])("classifies client-output stalls as $cause", async ({ cause, sendUpstreamBytes, expectedBytesAfterOutput }) => {
  vi.useFakeTimers();
  let upstream;
  const onSnapshot = vi.fn();
  const onError = vi.fn();
  const diagLog = vi.fn();
  const control = createStreamController({ onError, log: { errorLine() {} } });
  const response = new Response(new ReadableStream({ start(c) { upstream = c; } }));
  control.signal.addEventListener("abort", () => upstream.error(new DOMException("aborted", "AbortError")));
  const transform = new TransformStream({ transform(chunk, c) { if (chunk[0] !== 0) c.enqueue(chunk); } });
  const output = pipeWithDisconnect(response, transform, control, null, 10_000,
    { onSnapshot, log: diagLog }, 5_000);
  const consuming = new Response(output).arrayBuffer();
  upstream.enqueue(new Uint8Array([1, 2]));
  await vi.advanceTimersByTimeAsync(4_000);
  if (sendUpstreamBytes) upstream.enqueue(new Uint8Array([0, 3, 4]));
  await vi.advanceTimersByTimeAsync(2_000);
  await consuming;

  const failure = onError.mock.calls[0][0];
  const snapshot = onSnapshot.mock.calls[0][0];
  expect(failure).toMatchObject({ code: "UPSTREAM_VISIBLE_STALL", stallCause: cause });
  expect(failure.message).toContain(`cause=${cause}`);
  expect(diagLog).toHaveBeenCalledWith(expect.stringContaining(`cause=${cause}`));
  expect(snapshot).toMatchObject({
    stage: "visible_stall", upstreamBytes: 2 + expectedBytesAfterOutput,
    transformedBytes: 2, upstreamBytesAtLastVisible: 2,
    upstreamBytesSinceLastVisible: expectedBytesAfterOutput,
  });
  expect(vi.getTimerCount()).toBe(0);
});

it("stores only allowlisted transport error codes, never error messages", async () => {
  const onSnapshot = vi.fn();
  const control = createStreamController({ log: { errorLine() {} } });
  const failure = Object.assign(new Error("private response text"), { cause: { code: "UND_ERR_SOCKET" } });
  const response = new Response(new ReadableStream({ start(c) { c.error(failure); } }));
  await new Response(pipeWithDisconnect(response, new TransformStream(), control, null, 5000, { onSnapshot })).text();
  expect(onSnapshot).toHaveBeenCalledOnce();
  expect(onSnapshot.mock.calls[0][0]).toMatchObject({ stage: "stream_error", errorCode: "UND_ERR_SOCKET" });
  expect(JSON.stringify(onSnapshot.mock.calls)).not.toContain("private response text");
});

it("captures an incoming-client abort before its settlement hook", async () => {
  vi.useFakeTimers();
  const client = new AbortController(), onSnapshot = vi.fn();
  const control = createStreamController({ clientSignal: client.signal, log: { line() {} },
    onDisconnect: () => expect(onSnapshot).toHaveBeenCalledOnce() });
  let upstream;
  const response = new Response(new ReadableStream({ start(c) { upstream = c; } }));
  const out = pipeWithDisconnect(response, new TransformStream(), control, null, 5000, { onSnapshot });
  control.signal.addEventListener("abort", () => upstream.error(new DOMException("aborted", "AbortError")));
  const consume = new Response(out).text();
  client.abort(); await consume;
  expect(onSnapshot.mock.calls[0][0].stage).toBe("controller_abort");
  expect(vi.getTimerCount()).toBe(0);
});
