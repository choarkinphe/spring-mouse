import { describe, expect, it, vi } from "vitest";
import { CodexExecutor } from "../../open-sse/executors/codex.js";

const encoder = new TextEncoder();
const prefix = `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: "x".repeat(200) })}\n\n`;
const abortReason = () => Object.assign(new Error("client disconnected"), { name: "ResponseAborted" });

async function replacementStream(cancel) {
  let controller;
  const upstream = new ReadableStream({
    start(c) { controller = c; c.enqueue(encoder.encode(prefix)); },
    cancel,
  });
  const result = await new CodexExecutor()._peekSseTransientError(new Response(upstream));
  expect(result.matched).toBeNull();
  return { stream: result.replacementBody, controller };
}

describe("Codex replacement stream cancellation", () => {
  it("waits for asynchronous upstream cancellation and consumes its rejection", async () => {
    let rejectCancel;
    const pendingCancel = new Promise((_, reject) => { rejectCancel = reject; });
    // Keep the deliberately rejected fixture observed even on the old implementation.
    pendingCancel.catch(() => {});
    const cancel = vi.fn(() => pendingCancel);
    const { stream } = await replacementStream(cancel);
    const reason = abortReason();
    let settled = false;
    const result = stream.cancel(reason).then(() => { settled = true; });
    await new Promise(resolve => setImmediate(resolve));
    const settledBeforeCleanup = settled;
    rejectCancel(reason);
    await expect(result).resolves.toBeUndefined();
    expect(settledBeforeCleanup).toBe(false);
    expect(cancel).toHaveBeenCalledExactlyOnceWith(reason);
  });

  it("handles cancellation after the upstream reader errors with ResponseAborted", async () => {
    const cancel = vi.fn();
    const { stream, controller } = await replacementStream(cancel);
    const reason = abortReason();
    controller.error(reason);
    await expect(stream.cancel(reason)).resolves.toBeUndefined();
    // Flush a turn so an escaped rejection fails Vitest, rather than a later test.
    await new Promise(resolve => setImmediate(resolve));
    expect(cancel).not.toHaveBeenCalled();
  });

  it("forwards cancellation to a healthy upstream once", async () => {
    const cancel = vi.fn(async () => {});
    const { stream } = await replacementStream(cancel);
    const reason = abortReason();
    await expect(stream.cancel(reason)).resolves.toBeUndefined();
    expect(cancel).toHaveBeenCalledExactlyOnceWith(reason);
  });

  it("preserves buffered output, unread tail and normal completion", async () => {
    const cancel = vi.fn();
    const { stream, controller } = await replacementStream(cancel);
    const tail = "event: response.completed\ndata: {\"type\":\"response.completed\"}\n\n";
    controller.enqueue(encoder.encode(tail));
    controller.close();
    await expect(new Response(stream).text()).resolves.toBe(prefix + tail);
    expect(cancel).not.toHaveBeenCalled();
  });

  it("preserves normal output and propagates non-cancellation read errors", async () => {
    const { stream, controller } = await replacementStream(vi.fn());
    const reader = stream.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe(prefix);
    const failure = new Error("upstream read failed");
    controller.error(failure);
    await expect(reader.read()).rejects.toBe(failure);
    reader.releaseLock();
  });
});
