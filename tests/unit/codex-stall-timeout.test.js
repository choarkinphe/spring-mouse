/**
 * A Codex account can accept a request and then never send a byte: measured on
 * production, one account swallowed 40 requests in a day, each ending after
 * ~343s with pt=0 ct=0 — nothing upstream ever arrived. The byte-silence
 * watchdog is the only thing that can catch that, and its default (360s) is far
 * too late: the client in front of this gateway (cc-switch) gives up at ~180s
 * on its own streaming idle timeout, so spring-mouse was still holding the
 * request open 180s after the caller had already gone.
 *
 * These pin the two properties that matter: Codex must override the default, and
 * the override must fire before the caller's patience runs out.
 */
import { describe, expect, it } from "vitest";
import { PROVIDERS } from "../../open-sse/providers/index.js";
import { STREAM_STALL_TIMEOUT_MS } from "../../open-sse/config/runtimeConfig.js";

// The idle timeout cc-switch applies to a streaming response before it gives up
// and the client reports "the response stopped arriving". Measured from its
// proxy_config (streaming_idle_timeout = 180s).
const CLIENT_IDLE_TIMEOUT_MS = 180_000;

describe("Codex byte-silence watchdog", () => {
  it("overrides the 360s default with a codex-specific bound", () => {
    const stall = PROVIDERS.codex?.stallTimeoutMs;
    expect(stall).toBeDefined();
    expect(stall).toBeLessThan(STREAM_STALL_TIMEOUT_MS);
  });

  it("gives up before the client does, so the caller gets a terminal frame instead of a hang", () => {
    // Strictly below the client's idle timeout: firing at or after it would mean
    // the caller has already disconnected and spring-mouse is waiting for nobody.
    expect(PROVIDERS.codex.stallTimeoutMs).toBeLessThan(CLIENT_IDLE_TIMEOUT_MS);
  });

  it("stays above the slowest legitimate turn, so long reasoning is not killed", () => {
    // Codex success TTFT has a real long tail on production: 189 turns at 60-90s,
    // 16 at 90-120s and 8 at 120-180s. Those are genuine work — prompts of
    // 184k-336k tokens whose first token simply takes a long time — and the
    // slowest measured was 165.7s. A bound below that aborts real turns to catch
    // a stall, which is the wrong trade.
    const SLOWEST_MEASURED_LEGITIMATE_TURN_MS = 165_688;
    expect(PROVIDERS.codex.stallTimeoutMs).toBeGreaterThan(SLOWEST_MEASURED_LEGITIMATE_TURN_MS);
  });

  it("is a per-provider override, not a change to the global default", () => {
    // Other providers keep the generous default: the long bound exists so slow
    // reasoning models are not aborted mid-stream.
    expect(STREAM_STALL_TIMEOUT_MS).toBeGreaterThan(PROVIDERS.codex.stallTimeoutMs);
  });
});
