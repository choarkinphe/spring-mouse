// Regression guard for a routing bug that made every concurrency rejection lie.
//
// A queue timeout used to hardcode `retryAfterMs = 1000`, so the handler sent
// `Retry-After: 1` and "retry after 1s" to clients no matter how long the request
// had actually waited (the real queue window is 60s). Clients retried a second
// later, re-queued for another full window and failed again — a self-inflicted
// retry storm on an already saturated gate.
//
// The advisory delay must now reflect the observed saturation window, while the
// true wait is preserved separately for logs.
import { describe, it, expect } from "vitest";
import { RoutingQueueTimeoutError } from "../../src/lib/redis/connectionSlots.js";

describe("RoutingQueueTimeoutError retry hints", () => {
  it("reports the real wait separately from the advisory delay", () => {
    const error = new RoutingQueueTimeoutError("codex", 60_000);
    expect(error.code).toBe("ROUTING_QUEUE_TIMEOUT");
    expect(error.providerId).toBe("codex");
    expect(error.queueTimeoutMs).toBe(60_000);
    expect(error.retryAfterMs).toBe(60_000);
    expect(error.message).toContain("60000ms");
  });

  it("no longer advertises the hardcoded 1s for a real saturation window", () => {
    for (const waited of [30_000, 60_000, 120_000]) {
      expect(new RoutingQueueTimeoutError("codex", waited).retryAfterMs).not.toBe(1000);
    }
  });

  it("floors short windows so clients cannot retry in lockstep", () => {
    const error = new RoutingQueueTimeoutError("codex", 500);
    expect(error.retryAfterMs).toBe(5_000);
    // The floor applies to the hint only — the real wait is still reported verbatim.
    expect(error.queueTimeoutMs).toBe(500);
    expect(error.message).toContain("500ms");
  });

  it("caps long windows so the hint stays actionable", () => {
    expect(new RoutingQueueTimeoutError("codex", 30 * 60 * 1000).retryAfterMs).toBe(60_000);
  });

  it("honours an explicit retry hint without losing the real wait", () => {
    const error = new RoutingQueueTimeoutError("codex", 60_000, 12_000);
    expect(error.retryAfterMs).toBe(12_000);
    expect(error.queueTimeoutMs).toBe(60_000);
  });
});
