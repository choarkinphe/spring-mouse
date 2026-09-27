/**
 * The Codex SSE preamble scan must not outlive a hard bound.
 *
 * Stage instrumentation on production caught the scan running past 30s on a turn
 * whose upstream fetch took only 1.6s — the whole request time was the scan. The
 * turns that hang for 300s+ show only the two routing lines in the log and no
 * requestDetail, which is the signature of a scan that never returned.
 *
 * The scan already has phase deadlines (a 60s preamble, a 2s post-output grace),
 * but those are recomputed per iteration, so this pins the unconditional backstop
 * that sits outside them: whatever the phase logic computes, the scan ends.
 *
 * The bound is read at module load, so it is set before importing the executor.
 */
import { beforeAll, describe, expect, it } from "vitest";

// Short enough to assert on; stands in for the 90s production default.
process.env.SPRING_MOUSE_CODEX_SSE_SCAN_MAX_MS = "700";

let CodexExecutor;

beforeAll(async () => {
  ({ CodexExecutor } = await import("../../open-sse/executors/codex.js"));
});

/**
 * An SSE body that emits one metadata frame immediately and then keeps emitting a
 * frame just often enough to keep a per-iteration deadline alive — the "dripping
 * metadata frames" shape that a phase-based bound cannot stop.
 */
function drippingStream({ dripEveryMs = 40, frames = 2000 }) {
  const encoder = new TextEncoder();
  let sent = 0;
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(
        "event: response.created\ndata: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_1\"}}\n\n"
      ));
    },
    async pull(controller) {
      if (sent >= frames) { controller.close(); return; }
      await new Promise((r) => setTimeout(r, dripEveryMs));
      sent++;
      controller.enqueue(encoder.encode(
        `event: response.in_progress\ndata: {"type":"response.in_progress","seq":${sent},"pad":"${"x".repeat(64)}"}\n\n`
      ));
    },
  });
}

describe("Codex SSE scan backstop", () => {
  it("returns instead of scanning forever when metadata keeps dripping", async () => {
    const executor = new CodexExecutor();
    const response = new Response(drippingStream({ dripEveryMs: 40, frames: 2000 }), {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });

    const started = Date.now();
    // No request deadline: the phase bounds alone would let this drip indefinitely,
    // so only the backstop can end it.
    const peek = await executor._peekSseTransientError(response, Infinity);
    const elapsed = Date.now() - started;

    // It returned at all — the property that matters. Without the backstop this
    // scan ran until the upstream stopped or the byte ceiling was hit.
    expect(peek).toBeTruthy();
    expect(elapsed).toBeLessThan(5000);
    expect(peek.matched).toBeNull();
  }, 20000);

  it("still resolves a healthy stream promptly", async () => {
    const executor = new CodexExecutor();
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

    const started = Date.now();
    const peek = await executor._peekSseTransientError(response, Infinity);
    expect(peek.matched).toBeNull();
    expect(peek.replacementBody).toBeTruthy();
    // The backstop must not delay a healthy turn.
    expect(Date.now() - started).toBeLessThan(1000);
  }, 15000);
});
