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
