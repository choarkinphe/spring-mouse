import { afterEach, describe, expect, it, vi } from "vitest";
import { createCodexScanDiagnostics } from "../../open-sse/utils/codexScanDiagnostics.js";
import { CODEX_SCAN_DIAGNOSTICS } from "../../open-sse/config/runtimeConfig.js";
import { CodexExecutor } from "../../open-sse/executors/codex.js";

const frame = (type, extra = {}) => `event: ${type}\ndata: ${JSON.stringify({ type, ...extra })}\n\n`;
const encoder = new TextEncoder();
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("Codex scan diagnostic observer", () => {
  it("counts split CRLF and data-only frames without copying payloads", () => {
    const diag = createCodexScanDiagnostics(100);
    const text = frame("response.created", { response: { instructions: "secret prompt", tools: [{ description: "secret output" }] } }).replaceAll("\n", "\r\n")
      + 'data: {"type":"response.reasoning_text.delta","delta":"private reasoning"}\r\n\r\n';
    for (let i = 0; i < text.length; i += 7) diag.observe(text.slice(i, i + 7), 7, 200);
    const snapshot = diag.snapshot(300);
    expect(snapshot.eventCounts).toEqual({ "response.created": 1, "response.reasoning_text.delta": 1 });
    expect(snapshot).toMatchObject({ frames: 2, candidateFrames: 1, firstCandidateType: "response.reasoning_text.delta", lastChunkAgeMs: 100, candidateWithoutDetection: true });
    expect(JSON.stringify(snapshot)).not.toMatch(/secret|private reasoning|instructions|description/);
    diag.outputDetected(250);
    expect(diag.snapshot(300)).toMatchObject({ firstOutputAfterMs: 150, candidateWithoutDetection: false });
  });

  it("surfaces unrecognized delta and done-item content as candidates, not confirmed misses", () => {
    const diag = createCodexScanDiagnostics(0);
    diag.observe(frame("response.future.delta", { delta: "sensitive" }) + frame("response.output_item.done", { item: { type: "message", content: [{ type: "output_text", text: "answer" }] } }), 100, 10);
    expect(diag.snapshot(20)).toMatchObject({ candidateWithoutDetection: true, candidateFrames: 2, firstCandidateType: "other" });
    expect(JSON.stringify(diag.snapshot())).not.toContain("response.future.delta");
  });

  it("bounds oversized frames and recovers on the next frame", () => {
    const diag = createCodexScanDiagnostics(0);
    diag.observe(frame("response.created", { response: { instructions: "x".repeat(CODEX_SCAN_DIAGNOSTICS.maxFrameChars + 100) } }) + frame("response.refusal.delta", { delta: "private refusal" }), 100, 10);
    expect(diag.snapshot()).toMatchObject({ frames: 2, oversizedFrames: 1, candidateFrames: 1, firstCandidateType: "response.refusal.delta" });
    expect(JSON.stringify(diag.snapshot())).not.toContain("private refusal");
  });

  it("never copies unknown event labels or metadata strings into diagnostics", () => {
    const diag = createCodexScanDiagnostics(0);
    diag.observe(frame("Bearer-secret-token", { response: { instructions: "secret instructions" } }), 100, 10);
    const snapshot = diag.snapshot(20);
    expect(snapshot.eventCounts).toEqual({ other: 1 });
    expect(snapshot.eventHeaderCounts).toEqual({ other: 1 });
    expect(snapshot.candidateFrames).toBe(0);
    expect(JSON.stringify(snapshot)).not.toMatch(/secret|Bearer/);
  });

  it("reports incomplete and malformed frames without logging their data", () => {
    const diag = createCodexScanDiagnostics(0);
    diag.observe('event: response.output_text.delta\ndata: not-json\n\nevent: response.created\ndata: {"secret":', 100, 10);
    expect(diag.snapshot()).toMatchObject({ frames: 1, malformedFrames: 1, recognizedEventSeen: true });
    expect(diag.snapshot().pendingFrameChars).toBeGreaterThan(0);
    expect(JSON.stringify(diag.snapshot())).not.toContain("secret");
  });
});

describe("Codex scan diagnostic integration", () => {
  it("logs progress and end on metadata timeout, preserving cancellation and classification", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({ start(c) { c.enqueue(encoder.encode(frame("response.created", { response: { instructions: "do not log me" } }))); }, cancel }), { status: 200 });
    const log = { errorLine: vi.fn() };
    const executor = new CodexExecutor();
    const promise = executor._peekSseTransientError(response, Infinity, log, { scanId: "test-scan", attempt: 1 });
    await vi.advanceTimersByTimeAsync(30_001);
    expect(log.errorLine.mock.calls.some((args) => args[2].includes('"phase":"progress"'))).toBe(true);
    await vi.advanceTimersByTimeAsync(30_001);
    const result = await promise;
    expect(result).toMatchObject({ stoppedOnDeadline: true, stopReason: "preamble", replacementBody: null });
    expect(result.upstreamError.scanDiagnostics).toMatchObject({ scanId: "test-scan", candidateWithoutDetection: false, eventCounts: { "response.created": 1 } });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(log.errorLine.mock.calls.map((args) => args[2]).join("\n")).not.toContain("do not log me");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("observes an unrecognized output shape without changing existing detection policy", async () => {
    vi.useFakeTimers();
    const response = new Response(new ReadableStream({ start(c) { c.enqueue(encoder.encode(frame("response.refusal.delta", { delta: "secret refusal" }))); } }), { status: 200 });
    const log = { errorLine: vi.fn() };
    const promise = new CodexExecutor()._peekSseTransientError(response, Date.now() + 100, log);
    await vi.advanceTimersByTimeAsync(101);
    const result = await promise;
    expect(result.stoppedOnDeadline).toBe(true);
    expect(result.upstreamError.scanDiagnostics).toMatchObject({ candidateWithoutDetection: true, firstCandidateType: "response.refusal.delta" });
    expect(log.errorLine.mock.calls.map((args) => args[2]).join("\n")).not.toContain("secret refusal");
  });

  it("preserves healthy stream bytes and records recognition", async () => {
    const text = frame("response.output_text.delta", { delta: "hello" });
    const response = new Response(text, { status: 200 });
    const log = { errorLine: vi.fn() };
    const result = await new CodexExecutor()._peekSseTransientError(response, Infinity, log);
    expect(await new Response(result.replacementBody).text()).toBe(text);
    const record = JSON.parse(log.errorLine.mock.calls.at(-1)[2].split("CODEX-SCAN | ")[1]);
    expect(record).toMatchObject({ phase: "end", outputDetected: true, candidateWithoutDetection: false, eventCounts: { "response.output_text.delta": 1 } });
    expect(record.firstOutputAfterMs).not.toBeNull();
  });

  it("does not let a failed diagnostic logger break a healthy stream", async () => {
    const text = frame("response.output_text.delta", { delta: "hello" });
    const result = await new CodexExecutor()._peekSseTransientError(new Response(text), Infinity, { errorLine() { throw new Error("logger failed"); } });
    expect(await new Response(result.replacementBody).text()).toBe(text);
  });
});
