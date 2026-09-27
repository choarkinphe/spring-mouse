/**
 * A Codex turn can keep the UPSTREAM busy while starving the CLIENT. Measured on
 * production, the failing turns look like this:
 *
 *   healthy  up_bytes=3380375  vis_bytes=1248307  max_gap_ms=7022
 *   stalled  up_bytes=3513304  vis_bytes=415
 *            (client: "2 stream events received, none in the final 300004 ms")
 *
 * The upstream watchdog (`STREAM_STALL_TIMEOUT_MS`) cannot see this: it measures
 * silence from upstream, and the upstream never goes silent — it streams megabytes
 * of tool-call frames the translator buffers into almost nothing for the client.
 * Every byte-based upstream timer is reset by the very traffic the client cannot
 * use.
 *
 * These pin the client-side watchdog that closes that gap. The bound is 60s, ~8x
 * above the longest gap a healthy turn showed and far below the client's own ~300s
 * patience, so the gateway gives up first and can still rotate accounts.
 */
import { describe, expect, it, vi } from "vitest";
import { pipeWithDisconnect } from "../../open-sse/utils/streamHandler.js";
import { STREAM_VISIBLE_STALL_TIMEOUT_MS } from "../../open-sse/config/runtimeConfig.js";

// A value the upstream watchdog can never reach in these tests, so a failure can
// only come from the client-side bound under test.
const STREAM_STALL_TIMEOUT_MS_UNREACHABLE = 10 * 60 * 1000;

function controllerOf() {
  const state = { errors: [], aborted: false };
  return {
    state,
    controller: {
      signal: new AbortController().signal,
      startTime: Date.now(),
      isConnected: () => true,
      handleComplete: () => {},
      handleError: (e) => state.errors.push(e),
      handleDisconnect: () => {},
      abort: () => { state.aborted = true; },
    },
  };
}

function encoder() { return new TextEncoder(); }

/**
 * Upstream emits `upstreamChunk` repeatedly (keeping the upstream busy) while the
 * transform emits `clientChunk` only for the first few, simulating a translator
 * that buffers everything after the opening frames.
 */
function starvingStream({ upstreamChunk, clientChunk, clientChunks = 2, intervalMs = 20, runForMs = 1200 }) {
  let elapsed = 0;
  let emitted = 0;
  return new ReadableStream({
    async pull(controller) {
      if (elapsed >= runForMs) { controller.close(); return; }
      await new Promise((r) => setTimeout(r, intervalMs));
      elapsed += intervalMs;
      controller.enqueue(encoder().encode(upstreamChunk));
      if (emitted < clientChunks) emitted++;
    },
  });
}

/** Passes only the first `n` chunks through, then swallows the rest. */
function starvingTransform(n) {
  let seen = 0;
  return new TransformStream({
    transform(chunk, controller) {
      seen++;
      if (seen <= n) controller.enqueue(chunk);
    },
  });
}

describe("client-visible stall watchdog", () => {
  it("aborts a turn whose upstream is busy but whose client is starved", async () => {
    const { state, controller } = controllerOf();
    const upstream = starvingStream({
      upstreamChunk: "data: " + "x".repeat(200) + "\n\n",
      clientChunk: "data: {}\n\n",
      clientChunks: 2,
      runForMs: 4000,
    });

    const out = pipeWithDisconnect(
      new Response(upstream, { headers: { "content-type": "text/event-stream" } }),
      starvingTransform(2),
      controller,
      null,
      STREAM_STALL_TIMEOUT_MS_UNREACHABLE, // upstream watchdog must NOT be what fires
      null,
      300, // visible stall bound for the test
    );

    // Drain until the watchdog fires and the stream ends.
    const reader = out.getReader();
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && state.errors.length === 0) {
      const { done } = await reader.read().catch(() => ({ done: true }));
      if (done) break;
    }

    expect(state.errors.length).toBeGreaterThan(0);
    expect(state.errors[0].code).toBe("UPSTREAM_VISIBLE_STALL");
    expect(state.aborted).toBe(true);
  }, 15000);

  it("does not fire while the client keeps receiving", async () => {
    const { state, controller } = controllerOf();
    // Upstream and client both keep flowing well past the visible bound.
    const upstream = starvingStream({
      upstreamChunk: "data: " + "x".repeat(50) + "\n\n",
      clientChunk: "data: {}\n\n",
      clientChunks: 1000,
      runForMs: 1500,
    });

    const out = pipeWithDisconnect(
      new Response(upstream, { headers: { "content-type": "text/event-stream" } }),
      new TransformStream(), // passes everything through
      controller,
      null,
      STREAM_STALL_TIMEOUT_MS_UNREACHABLE,
      null,
      300,
    );

    const reader = out.getReader();
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const { done } = await reader.read().catch(() => ({ done: true }));
      if (done) break;
    }

    expect(state.errors.filter((e) => e.code === "UPSTREAM_VISIBLE_STALL")).toHaveLength(0);
  }, 15000);

  it("clears the widest gap a healthy turn has shown, with margin", () => {
    // Measured on healthy production turns: min 8.2s, p50 15.4s, p90 41.2s,
    // max 58.1s. The first bound was 60s, picked from a single 7s sample — only
    // ~2s above the eventual maximum, which would have aborted healthy turns.
    const WIDEST_MEASURED_HEALTHY_GAP_MS = 58_107;
    expect(STREAM_VISIBLE_STALL_TIMEOUT_MS).toBeGreaterThan(WIDEST_MEASURED_HEALTHY_GAP_MS * 2);
  });

  it("still fires well before the client gives up on its own", () => {
    // The client abandons at ~300s ("none in the final 300004 ms"), so the gateway
    // must fire first — otherwise it waits on a caller that has already gone.
    expect(STREAM_VISIBLE_STALL_TIMEOUT_MS).toBeLessThan(300_000);
  });
});
