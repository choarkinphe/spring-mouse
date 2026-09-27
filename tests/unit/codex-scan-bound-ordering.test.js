/**
 * The SSE preamble scan has ONE authoritative bound: `CODEX_SSE_SCAN_MAX_MS`, the
 * total wall-clock ceiling. The preamble phase bound (`CODEX_SSE_PREAMBLE_MS`) is
 * clamped by it, so the phase bound can only stop a scan EARLIER — never later.
 *
 * This is the inverse of the arrangement it replaced. That version had a 90s
 * "backstop" sitting ABOVE the 60s preamble bound, and since both deadlines are
 * computed once before the loop, `min(now+60s, RD) <= now+90s` always held: the
 * preamble bound always fired first and the backstop was dead code. A production
 * log showing "backstop=0" read as "the backstop is broken" when it actually meant
 * "the preamble bound stopped it" — which is exactly how it was misread.
 *
 * Now the ceiling is what stops an unresolved scan, and it says so. The bounds are
 * scaled ~30x in these tests so they run in seconds.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

/** Emits `response.created` then drips metadata frames forever — no output, no error. */
function drippingMetadataStream({ dripEveryMs = 25 } = {}) {
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

/** Loads a fresh executor module with the given bounds (they are read at import time). */
async function executorWith({ preambleMs, scanMaxMs }) {
  if (preambleMs != null) process.env.SPRING_MOUSE_CODEX_SSE_PREAMBLE_MS = String(preambleMs);
  if (scanMaxMs != null) process.env.SPRING_MOUSE_CODEX_SSE_SCAN_MAX_MS = String(scanMaxMs);
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

describe("Codex SSE scan total ceiling", () => {
  beforeEach(() => {
    delete process.env.SPRING_MOUSE_CODEX_SSE_PREAMBLE_MS;
    delete process.env.SPRING_MOUSE_CODEX_SSE_SCAN_MAX_MS;
  });

  it("the ceiling stops the scan when it is tighter than the preamble bound (the shipped default)", async () => {
    // Shipped ordering, scaled: ceiling 1.2s < preamble 3s.
    const executor = await executorWith({ preambleMs: 3000, scanMaxMs: 1200 });
    const { lines, log } = logCapture();
    const response = new Response(drippingMetadataStream(), {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });

    const started = Date.now();
    const peek = await executor._peekSseTransientError(response, Date.now() + 120_000, log);
    const elapsed = Date.now() - started;

    // Stopped at the ceiling, not the 3s preamble bound.
    expect(elapsed).toBeGreaterThan(900);
    expect(elapsed).toBeLessThan(3000);

    // Unresolved (the 503 path), and it named the bound that fired.
    expect(peek.stoppedOnDeadline).toBe(true);
    expect(peek.stopReason).toBe("scan-ceiling");
    expect(peek.replacementBody).toBeNull();
    expect(lines.some((m) => /total ceiling/i.test(m))).toBe(true);
  }, 15000);

  it("the preamble bound can still stop a scan earlier, and is named", async () => {
    // Ceiling 5s, preamble 1.2s: the phase bound fires first and must say so.
    const executor = await executorWith({ preambleMs: 1200, scanMaxMs: 5000 });
    const { lines, log } = logCapture();
    const response = new Response(drippingMetadataStream(), {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });

    const started = Date.now();
    const peek = await executor._peekSseTransientError(response, Date.now() + 120_000, log);
    const elapsed = Date.now() - started;

    expect(elapsed).toBeGreaterThan(900);
    expect(elapsed).toBeLessThan(4000);
    expect(peek.stoppedOnDeadline).toBe(true);
    expect(peek.stopReason).toBe("preamble");
    // The ceiling line is absent because the ceiling did not fire.
    expect(lines.some((m) => /total ceiling/i.test(m))).toBe(false);
  }, 15000);

  it("never lets a raised preamble bound extend a scan past the ceiling", async () => {
    // The old bug in one assertion: an operator raising the preamble bound must NOT
    // be able to push a scan beyond the ceiling.
    const executor = await executorWith({ preambleMs: 60_000, scanMaxMs: 1000 });
    const { log } = logCapture();
    const response = new Response(drippingMetadataStream(), {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });

    const started = Date.now();
    const peek = await executor._peekSseTransientError(response, Date.now() + 120_000, log);
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(3000);
    expect(peek.stoppedOnDeadline).toBe(true);
    expect(peek.stopReason).toBe("scan-ceiling");
  }, 15000);

  it("resolves the ceiling first when the two bounds are equal (the shipped default)", async () => {
    // Shipped defaults are ceiling == preamble == 60s. Equal bounds are the one case
    // where "which fired" is ambiguous, so the ceiling is checked FIRST in the loop
    // and must win. Without that ordering an operator would again see a stop with no
    // line naming the bound — the misread this whole change exists to prevent.
    const executor = await executorWith({ preambleMs: 1200, scanMaxMs: 1200 });
    const { lines, log } = logCapture();
    const response = new Response(drippingMetadataStream(), {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });

    const peek = await executor._peekSseTransientError(response, Date.now() + 120_000, log);
    expect(peek.stoppedOnDeadline).toBe(true);
    expect(peek.stopReason).toBe("scan-ceiling");
    expect(lines.some((m) => /total ceiling/i.test(m))).toBe(true);
  }, 15000);

  it("does not log a ceiling stop when output has already begun (no false alarm)", async () => {
    // A healthy turn that crosses the ceiling mid-flight must NOT be reported as
    // "giving up" — the stream is fine and is released. The ceiling only ends an
    // UNRESOLVED scan.
    const executor = await executorWith({ preambleMs: 300, scanMaxMs: 300 });
    const encoder = new TextEncoder();
    // A reasoning delta arrives first (so output starts), then the stream drips
    // slowly past the 300ms ceiling without ever reaching the grace thresholds.
    let sent = 0;
    const response = new Response(new ReadableStream({
      start(c) {
        c.enqueue(encoder.encode('event: response.reasoning_summary_text.delta\ndata: {"type":"response.reasoning_summary_text.delta","delta":"think"}\n\n'));
      },
      async pull(c) {
        await new Promise((r) => setTimeout(r, 60));
        if (sent++ > 40) { c.close(); return; }
        c.enqueue(encoder.encode('event: response.reasoning_summary_text.delta\ndata: {"type":"response.reasoning_summary_text.delta","delta":"more"}\n\n'));
      },
    }), { status: 200, headers: { "Content-Type": "text/event-stream" } });

    const { lines, log } = logCapture();
    const peek = await executor._peekSseTransientError(response, Date.now() + 120_000, log);

    // Released as healthy, and the ceiling line never fired.
    expect(peek.stoppedOnDeadline).toBe(false);
    expect(peek.replacementBody).toBeTruthy();
    expect(lines.some((m) => /total ceiling/i.test(m))).toBe(false);
  }, 15000);

  it("still resolves a healthy stream promptly, well before any bound", async () => {
    const executor = await executorWith({ preambleMs: 3000, scanMaxMs: 1200 });
    const encoder = new TextEncoder();
    const frames = [
      "event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"" + "y".repeat(300) + "\"}\n\n",
      "event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\"}}\n\n",
    ];
    let i = 0;
    const response = new Response(new ReadableStream({
      async pull(controller) {
        if (i >= frames.length) { controller.close(); return; }
        controller.enqueue(encoder.encode(frames[i++]));
      },
    }), { status: 200, headers: { "Content-Type": "text/event-stream" } });

    const { log } = logCapture();
    const started = Date.now();
    const peek = await executor._peekSseTransientError(response, Date.now() + 120_000, log);
    expect(peek.matched).toBeNull();
    expect(peek.replacementBody).toBeTruthy();
    expect(Date.now() - started).toBeLessThan(900);
  }, 15000);
});
