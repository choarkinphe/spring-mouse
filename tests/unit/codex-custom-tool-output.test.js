import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexExecutor } from "../../open-sse/executors/codex.js";
import { createCodexScanDiagnostics } from "../../open-sse/utils/codexScanDiagnostics.js";

const type = "response.custom_tool_call_input.delta";
const doneType = "response.custom_tool_call_input.done";
const encoder = new TextEncoder();
const frame = (event, extra = {}) => `event: ${event}\ndata: ${JSON.stringify({ type: event, ...extra })}\n\n`;
const overload = frame("error", { error: { code: "server_is_overloaded", message: "Our servers are currently overloaded. Please try again later." } });
const record = (log) => JSON.parse(log.errorLine.mock.calls.at(-1)[2].split("CODEX-SCAN | ")[1]);

function openStream(text) {
  let controller;
  const cancel = vi.fn();
  const response = new Response(new ReadableStream({
    start(c) { controller = c; c.enqueue(encoder.encode(text)); },
    cancel,
  }), { headers: { "content-type": "text/event-stream" } });
  return { response, cancel, controller };
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("Codex custom tool first output", () => {
  it.each(["event", "data-only"])("releases %s custom input after the normal output grace, not the preamble timeout", async (format) => {
    vi.useFakeTimers();
    const preamble = frame("response.created", { response: { instructions: "private instructions" } });
    const { response, controller, cancel } = openStream(preamble);
    const log = { errorLine: vi.fn() };
    const pending = new CodexExecutor()._peekSseTransientError(response, Infinity, log);
    await vi.advanceTimersByTimeAsync(13_337);
    const output = format === "event" ? frame(type, { delta: "private tool input" })
      : `data: ${JSON.stringify({ type, delta: "private tool input" })}\n\n`;
    controller.enqueue(encoder.encode(output));
    await vi.advanceTimersByTimeAsync(2_001);
    expect(log.errorLine).toHaveBeenCalled();
    const result = await pending;
    expect(result).toMatchObject({ matched: null, stoppedOnDeadline: false });
    expect(record(log)).toMatchObject({ outputDetected: true, firstOutputType: type, releaseReason: "output-grace", recognizedEventSeen: true, candidateWithoutDetection: false, firstCandidateType: type });
    expect(record(log).elapsedMs).toBeLessThan(16_000);
    expect(cancel).not.toHaveBeenCalled();
    controller.close();
    expect(await new Response(result.replacementBody).text()).toBe(preamble + output);
    expect(JSON.stringify(log.errorLine.mock.calls)).not.toMatch(/private instructions|private tool input/);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("counts custom input characters and preserves split CRLF/UTF-8 bytes and the unread tail", async () => {
    vi.useFakeTimers();
    const preamble = frame("response.created");
    const output = frame(type, { delta: "工具输入".repeat(100) }).replaceAll("\n", "\r\n");
    const { response, controller } = openStream(preamble);
    const log = { errorLine: vi.fn() };
    const pending = new CodexExecutor()._peekSseTransientError(response, Infinity, log);
    const bytes = encoder.encode(output);
    for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7));
    await vi.advanceTimersByTimeAsync(1);
    expect(log.errorLine).toHaveBeenCalled();
    const result = await pending;
    expect(record(log)).toMatchObject({ outputDetected: true, firstOutputType: type, releaseReason: "output-grace" });
    expect(record(log).elapsedMs).toBeLessThan(2_000);
    const tail = frame(doneType, { input: "fixture done" }) + frame("response.completed");
    controller.enqueue(encoder.encode(tail));
    controller.close();
    const actual = new Uint8Array(await new Response(result.replacementBody).arrayBuffer());
    expect(actual).toEqual(encoder.encode(preamble + output + tail));
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["same-chunk", "delayed"])("still catches overload after a short custom input delta (%s)", async (timing) => {
    vi.useFakeTimers();
    const output = frame(type, { delta: "short" });
    const { response, controller, cancel } = openStream(output + (timing === "same-chunk" ? overload : ""));
    const log = { errorLine: vi.fn() };
    const pending = new CodexExecutor()._peekSseTransientError(response, Infinity, log);
    if (timing === "delayed") {
      await vi.advanceTimersByTimeAsync(300);
      controller.enqueue(encoder.encode(overload));
    }
    const result = await pending;
    expect(result).toMatchObject({ matched: "server_is_overloaded", accountFallback: false, replacementBody: null, stoppedOnDeadline: false });
    expect(record(log).releaseReason).toBe("upstream-error");
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not mistake overload text in custom tool input for an error", async () => {
    const text = frame(type, { delta: "Our servers are currently overloaded; server_is_overloaded" });
    const log = { errorLine: vi.fn() };
    const result = await new CodexExecutor()._peekSseTransientError(new Response(text), Infinity, log);
    expect(result.matched).toBeNull();
    expect(record(log).outputDetected).toBe(true);
    expect(await new Response(result.replacementBody).text()).toBe(text);
  });

  it("does not promote unknown delta events to recognized output", async () => {
    vi.useFakeTimers();
    const { response, cancel } = openStream(frame("response.future.delta", { delta: "private" }));
    const log = { errorLine: vi.fn() };
    const pending = new CodexExecutor()._peekSseTransientError(response, Date.now() + 100, log);
    await vi.advanceTimersByTimeAsync(101);
    expect(await pending).toMatchObject({ stoppedOnDeadline: true, stopReason: "request", replacementBody: null });
    expect(record(log)).toMatchObject({ outputDetected: false, recognizedEventSeen: false, candidateWithoutDetection: true, firstCandidateType: "other" });
    expect(JSON.stringify(log.errorLine.mock.calls)).not.toMatch(/private|response.future.delta/);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("logs only allowlisted custom event labels, never their input", () => {
    const diag = createCodexScanDiagnostics(0);
    const text = frame(type, { delta: "private arguments" }) + frame(doneType, { input: "private done input" });
    for (let i = 0; i < text.length; i += 7) diag.observe(text.slice(i, i + 7), 7, 100);
    expect(diag.snapshot(200)).toMatchObject({ frames: 2, firstCandidateType: type, candidateFrames: 1, recognizedEventSeen: true, eventCounts: { [type]: 1, [doneType]: 1 }, eventHeaderCounts: { [type]: 1, [doneType]: 1 } });
    expect(JSON.stringify(diag.snapshot(200))).not.toMatch(/private|arguments/);
  });
});
