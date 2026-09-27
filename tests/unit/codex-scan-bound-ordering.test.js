/**
 * Which bound actually stops an unresolved Codex SSE scan — and why a
 * "backstop=0" production log is not evidence the backstop failed.
 *
 * Production evidence (2026-09-27, container restarted 07:07Z):
 *
 *   CODEX-STAGE | peekSseTransientError (attempt 1) ... 30000ms   (x6)
 *   CODEX-STAGE | peekSseTransientError (attempt 2) ... 30000ms   (x3)
 *   "backstop" log lines: 0
 *
 * That looks like the backstop never taking effect. It is not. The stage timer
 * fires WHILE a stage is still running, so those lines only prove the scan had
 * not finished after 30s — which it is allowed to be, up to its 60s preamble
 * bound. Both bounds are computed once, before the loop:
 *
 *   preambleDeadline = min(now + PREAMBLE_MS, requestDeadline)   // 60s default
 *   scanDeadline     = now + SCAN_MAX_MS                         // 90s default
 *
 * so with the shipped defaults `min(now+60s, RD) <= now+90s` always holds and the
 * preamble bound wins. The backstop can only be the binding bound when an
 * operator raises PREAMBLE_MS above SCAN_MAX_MS (or the phase logic is changed to
 * recompute its deadline per iteration). It is a guard for that, not the working
 * bound — which is exactly what the comment on CODEX_SSE_SCAN_MAX_MS says.
 *
 * Both cases are pinned below, each with the two bounds scaled down ~40x so the
 * tests run in seconds while preserving the production ordering.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/** Emits `response.created` then drips metadata frames forever — no output, no error. */
function drippingMetadataStream({ dripEveryMs = 30 } = {}) {
  const encoder = new TextEncoder();
  let sent = 0;
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(
        "event: response.created\ndata: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_1\"}}\n\n"
      ));
    },
    async pull(controller) {
      await new Promise((r) => setTimeout(r, dripEveryMs));
      sent++;
      controller.enqueue(encoder.encode(
        `event: response.in_progress\ndata: {"type":"response.in_progress","seq":${sent}}\n\n`
      ));
    },
  });
}

/** Loads a fresh executor module with the given bounds, since they are read at import time. */
async function executorWith({ preambleMs, scanMaxMs }) {
  process.env.SPRING_MOUSE_CODEX_SSE_PREAMBLE_MS = String(preambleMs);
  process.env.SPRING_MOUSE_CODEX_SSE_SCAN_MAX_MS = String(scanMaxMs);
  vi.resetModules();
  const { CodexExecutor } = await import("../../open-sse/executors/codex.js");
  return new CodexExecutor();
}

function logCapture() {
  const lines = [];
  return {
    lines,
    log: { errorLine: (_a, _b, msg) => lines.push(String(msg)), warn: () => {}, info: () => {}, debug: () => {} },
  };
}

describe("Codex scan bounds", () => {
  beforeEach(() => {
    delete process.env.SPRING_MOUSE_CODEX_SSE_PREAMBLE_MS;
    delete process.env.SPRING_MOUSE_CODEX_SSE_SCAN_MAX_MS;
  });

  it("stops at the preamble bound (not the backstop) when preamble < backstop, and logs no backstop", async () => {
    // Production ordering, scaled 40x: preamble 1.5s, backstop 5s.
    const executor = await executorWith({ preambleMs: 1500, scanMaxMs: 5000 });
    const { lines, log } = logCapture();
    const response = new Response(drippingMetadataStream(), {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });

    const started = Date.now();
    // A request deadline far beyond both bounds, as production's 120s budget is.
    const peek = await executor._peekSseTransientError(response, Date.now() + 120_000, log);
    const elapsed = Date.now() - started;

    // Resolved at ~the preamble bound, well before the 5s backstop.
    expect(elapsed).toBeGreaterThan(1000);
    expect(elapsed).toBeLessThan(4000);

    // Reported as UNRESOLVED (the 503 path), not handed over as a healthy stream.
    expect(peek.stoppedOnDeadline).toBe(true);
    expect(peek.replacementBody).toBeNull();

    // The backstop line is absent: it never fired. This is the production signature.
    expect(lines.some((m) => /backstop/i.test(m))).toBe(false);
  }, 15000);

  it("fires the backstop when it is the tighter bound (preamble > backstop)", async () => {
    // The only configuration where the backstop is reachable: an operator raising
    // the preamble bound past it. Scaled: preamble 10s, backstop 1.2s.
    const executor = await executorWith({ preambleMs: 10_000, scanMaxMs: 1200 });
    const { lines, log } = logCapture();
    const response = new Response(drippingMetadataStream(), {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });

    const started = Date.now();
    const peek = await executor._peekSseTransientError(response, Date.now() + 120_000, log);
    const elapsed = Date.now() - started;

    // Stopped at the backstop, not the 10s preamble bound.
    expect(elapsed).toBeGreaterThan(900);
    expect(elapsed).toBeLessThan(4000);
    expect(peek.stoppedOnDeadline).toBe(true);
    // And it said so, so an operator can tell which bound did it.
    expect(lines.some((m) => /backstop/i.test(m))).toBe(true);
  }, 15000);
});
