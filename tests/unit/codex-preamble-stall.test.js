/**
 * Regression: an upstream that sends ONLY the metadata frames and then hangs.
 *
 * Codex streams `response.created` + `response.in_progress` first (each echoing the
 * full tools schema). If the upstream then dies without ever emitting content or an
 * error, the preamble scan's own bound (CODEX_SSE_PREAMBLE_MS, default 60s) is what
 * stops it — NOT the caller's request deadline.
 *
 * That distinction used to decide whether the stop was reported as unresolved:
 *   if (deadline === requestDeadline && !outputStarted && !matched) stoppedOnDeadline = true;
 * The preamble bound is `min(now + PREAMBLE_MS, requestDeadline)`, so when it is the
 * shorter of the two it does not equal requestDeadline, `stoppedOnDeadline` stayed
 * false, and the caller treated the dead stream as HEALTHY and forwarded it. The
 * client then saw a couple of events and silence until its own watchdog fired —
 * observed on production as "2 stream events received, first after 22458 ms, none in
 * the final 300008 ms".
 *
 * A stop with no output and no error is unresolved regardless of WHICH bound fired.
 */
import { describe, expect, it, vi } from "vitest";

async function withPreambleMs(ms, fn) {
  const prev = process.env.SPRING_MOUSE_CODEX_SSE_PREAMBLE_MS;
  process.env.SPRING_MOUSE_CODEX_SSE_PREAMBLE_MS = String(ms);
  vi.resetModules();
  try {
    const mod = await import("../../open-sse/executors/codex.js");
    return await fn(mod.CodexExecutor);
  } finally {
    if (prev === undefined) delete process.env.SPRING_MOUSE_CODEX_SSE_PREAMBLE_MS;
    else process.env.SPRING_MOUSE_CODEX_SSE_PREAMBLE_MS = prev;
    vi.resetModules();
  }
}

const METADATA_ONLY =
  'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_1"}}\n\n' +
  'event: response.in_progress\ndata: {"type":"response.in_progress","response":{"id":"resp_1"}}\n\n';

const OVERLOAD_FRAME =
  'event: error\ndata: {"type":"error","error":{"type":"service_unavailable_error","code":"server_is_overloaded","message":"Our servers are currently overloaded. Please try again later."}}\n\n';

/** Emits the metadata frames, then never speaks again. */
function stalledAfterMetadata() {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(c) { c.enqueue(encoder.encode(METADATA_ONLY)); /* never closes */ },
  }), { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

function streamFromText(text) {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(c) { c.enqueue(encoder.encode(text)); c.close(); },
  }), { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

describe("codex: metadata-only stream that then hangs is unresolved, not healthy", () => {
  it("answers 503 when the PREAMBLE bound stops the scan (long caller budget)", async () => {
    await withPreambleMs(300, async (CodexExecutor) => {
      const executor = new CodexExecutor();
      executor.config = {
        ...executor.config,
        overloadRetry: { budgetMs: 60_000, baseDelayMs: 10, maxDelayMs: 10, factor: 1, minRetries: 0, maxAttempts: 5, minSleepMs: 1 },
      };
      const superExecute = vi.spyOn(Object.getPrototypeOf(CodexExecutor.prototype), "execute")
        .mockResolvedValue({ response: stalledAfterMetadata(), url: "u", headers: {} });

      const started = Date.now();
      const result = await executor.execute({
        model: "gpt-6-astra",
        body: {},
        stream: true,
        credentials: {},
        log: {},
        // Far in the future: only the preamble bound can stop this scan.
        overloadDeadline: Date.now() + 60_000,
      });
      const elapsed = Date.now() - started;
      superExecute.mockRestore();

      // Bounded by the 300ms preamble bound, and reported as unresolved.
      expect(elapsed).toBeLessThan(5000);
      expect(result.response.status).toBe(503);
      expect(result.response.__smUpstreamError?.origin).toBe("sse_overload");
    });
  }, 20000);

  it("still catches an overload frame that arrives inside the preamble", async () => {
    await withPreambleMs(300, async (CodexExecutor) => {
      const executor = new CodexExecutor();
      // A fresh Response per attempt: a Response body can only be read once, so a
      // shared instance would make the retry read an already-consumed stream.
      // maxAttempts:1 keeps the loop short — the point here is detection, not retries.
      executor.config = {
        ...executor.config,
        overloadRetry: { budgetMs: 60_000, baseDelayMs: 10, maxDelayMs: 10, factor: 1, minRetries: 0, maxAttempts: 1, minSleepMs: 1 },
      };
      const superExecute = vi.spyOn(Object.getPrototypeOf(CodexExecutor.prototype), "execute")
        .mockImplementation(async () => ({ response: streamFromText(METADATA_ONLY + OVERLOAD_FRAME), url: "u", headers: {} }));
      const result = await executor.execute({ model: "gpt-6-astra", body: {}, stream: true, credentials: {}, log: {} });
      superExecute.mockRestore();
      expect(result.response.status).toBe(503);
    });
  }, 20000);

  it("PREAMPLE_MS=0 keeps the old opt-out: only a real request deadline marks it unresolved", async () => {
    await withPreambleMs(0, async (CodexExecutor) => {
      const executor = new CodexExecutor();
      const superExecute = vi.spyOn(Object.getPrototypeOf(CodexExecutor.prototype), "execute")
        .mockResolvedValue({ response: stalledAfterMetadata(), url: "u", headers: {} });
      const result = await executor.execute({
        model: "gpt-6-astra", body: {}, stream: true, credentials: {}, log: {},
        // Already spent: the caller deadline is what stops the scan.
        overloadDeadline: Date.now() - 1,
      });
      superExecute.mockRestore();
      expect(result.response.status).toBe(503);
    });
  }, 20000);
});

// The other half of the same production report: every slow thinking request waited out
// the full preamble bound before the client saw anything, because the output detector
// only recognised text/function-call deltas — not reasoning. On xhigh models the first
// tens of seconds carry ONLY reasoning, so `outputStarted` never flipped and the
// content-aware grace window never engaged.
describe("codex: reasoning deltas count as output", () => {
  it("releases a reasoning-only stream immediately instead of waiting out the preamble bound", async () => {
    await withPreambleMs(60_000, async (CodexExecutor) => {
      const executor = new CodexExecutor();
      const reasoning = 'event: response.reasoning_summary_text.delta\n'
        + 'data: {"type":"response.reasoning_summary_text.delta","delta":"' + "t".repeat(400) + '"}\n\n';
      const superExecute = vi.spyOn(Object.getPrototypeOf(CodexExecutor.prototype), "execute")
        .mockResolvedValue({ response: streamFromText(reasoning), url: "u", headers: {} });

      const started = Date.now();
      const result = await executor.execute({ model: "gpt-6-astra", body: {}, stream: true, credentials: {}, log: {} });
      const elapsed = Date.now() - started;
      superExecute.mockRestore();

      // Well under the 60s preamble bound: the grace window released it.
      expect(elapsed).toBeLessThan(5000);
      expect(result.response.status).toBe(200);
      await expect(result.response.text()).resolves.toContain("reasoning_summary_text.delta");
    });
  }, 20000);

  it("still catches an overload frame that arrives together with reasoning output", async () => {
    await withPreambleMs(60_000, async (CodexExecutor) => {
      const executor = new CodexExecutor();
      executor.config = {
        ...executor.config,
        overloadRetry: { budgetMs: 60_000, baseDelayMs: 10, maxDelayMs: 10, factor: 1, minRetries: 0, maxAttempts: 1, minSleepMs: 1 },
      };
      const reasoning = 'event: response.reasoning_summary_text.delta\n'
        + 'data: {"type":"response.reasoning_summary_text.delta","delta":"thinking"}\n\n';
      const superExecute = vi.spyOn(Object.getPrototypeOf(CodexExecutor.prototype), "execute")
        .mockImplementation(async () => ({ response: streamFromText(METADATA_ONLY + reasoning + OVERLOAD_FRAME), url: "u", headers: {} }));
      const result = await executor.execute({ model: "gpt-6-astra", body: {}, stream: true, credentials: {}, log: {} });
      superExecute.mockRestore();
      expect(result.response.status).toBe(503);
    });
  }, 20000);
});