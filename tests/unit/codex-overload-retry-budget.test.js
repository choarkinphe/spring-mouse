/**
 * The Codex SSE-overload retry loop used to be a fixed attempt count with a
 * 1.5s backoff. Measured on production, one upstream attempt costs 10-30s before
 * the overload frame arrives, so that backoff was shorter than the attempt it was
 * backing off from: every retry landed in the same saturation window and the
 * request died after ~55s of retrying that could never have worked — even though
 * the same account was serving the same model successfully seconds later.
 *
 * The loop is now a TIME budget with exponential backoff. These pin both halves:
 * the delay curve, and the fact that the loop keeps retrying while the budget
 * lasts instead of stopping after a fixed count.
 */
import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_OVERLOAD_RETRY,
  REQUEST_OVERLOAD_BUDGET_MS,
  resolveOverloadDelayMs,
  resolveOverloadRetryConfig,
} from "../../open-sse/config/runtimeConfig.js";
import { CodexExecutor } from "../../open-sse/executors/codex.js";

const OVERLOAD_FRAME = [
  "event: error",
  'data: {"error":{"code":"server_is_overloaded","message":"Our servers are currently overloaded. Please try again later."}}',
  "",
].join("\n");

const OK_FRAME = [
  "event: response.completed",
  'data: {"type":"response.completed","response":{"status":"completed"}}',
  "",
].join("\n");

function sse(text) {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) { controller.enqueue(encoder.encode(text)); controller.close(); },
  }), { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

describe("overload retry delay curve", () => {
  it("starts far above the old 1.5s backoff and grows exponentially", () => {
    // The old value was 1500ms. Anything at or below it would reproduce the bug
    // this change exists to fix, so the floor is asserted explicitly.
    const first = resolveOverloadDelayMs(1);
    expect(first).toBeGreaterThan(1500);
    expect(first).toBe(DEFAULT_OVERLOAD_RETRY.baseDelayMs);

    // Monotonic growth, capped at maxDelayMs.
    const curve = [1, 2, 3, 4, 5].map((n) => resolveOverloadDelayMs(n));
    for (let i = 1; i < curve.length; i++) expect(curve[i]).toBeGreaterThanOrEqual(curve[i - 1]);
    expect(Math.max(...curve)).toBeLessThanOrEqual(DEFAULT_OVERLOAD_RETRY.maxDelayMs);
  });

  it("honours a config override", () => {
    expect(resolveOverloadDelayMs(1, { baseDelayMs: 100, maxDelayMs: 250, factor: 2 })).toBe(100);
    expect(resolveOverloadDelayMs(2, { baseDelayMs: 100, maxDelayMs: 250, factor: 2 })).toBe(200);
    expect(resolveOverloadDelayMs(3, { baseDelayMs: 100, maxDelayMs: 250, factor: 2 })).toBe(250);
  });
});

describe("Codex overload retry budget", () => {
  /** Execute with a stubbed upstream that always answers with the overload frame. */
  async function runAgainstOverload({ overloadRetry, overloadDeadline, calls }) {
    const executor = new CodexExecutor();
    executor.config = { ...executor.config, overloadRetry };
    vi.spyOn(executor, "_peekSseTransientError").mockImplementation(async () => {
      calls.count += 1;
      return {
        matched: "server_is_overloaded",
        message: "Our servers are currently overloaded. Please try again later.",
        accountFallback: false,
        replacementBody: null,
        upstreamError: { source: "sse", status: 200, message: "overloaded", body: "", retryAfterMs: null },
      };
    });
    const superExecute = vi.spyOn(Object.getPrototypeOf(CodexExecutor.prototype), "execute")
      .mockResolvedValue({ response: sse(OVERLOAD_FRAME), url: "u", headers: {} });

    const result = await executor.execute({ model: "gpt-5.6-sol", body: {}, stream: true, credentials: {}, log: {}, overloadDeadline });
    superExecute.mockRestore();
    return result;
  }

  it("keeps retrying past the old 2-retry cap while the budget lasts", async () => {
    // A tiny budget with a tiny delay still allows several retries, which the old
    // fixed `attempts: 2` config would have refused. `minRetries: 0` here so the
    // loop is bounded purely by the budget.
    const calls = { count: 0 };
    await runAgainstOverload({
      overloadRetry: { budgetMs: 300, baseDelayMs: 10, maxDelayMs: 10, factor: 1, minRetries: 0, maxAttempts: 50, minSleepMs: 1 },
      calls,
    });
    // 300ms budget / ~10ms delay → many more than the old 3 attempts (1 + 2 retries).
    expect(calls.count).toBeGreaterThan(3);
  }, 15000);

  it("stops immediately once the shared request deadline has passed", async () => {
    const calls = { count: 0 };
    await runAgainstOverload({
      overloadRetry: { budgetMs: 60_000, baseDelayMs: 10, maxDelayMs: 10, factor: 1, minRetries: 5, maxAttempts: 50, minSleepMs: 1 },
      overloadDeadline: Date.now() - 1, // already spent by an earlier model
      calls,
    });
    // minRetries is dropped when the request budget is gone, so the model fails
    // fast instead of spending another 60s on the same saturated upstream.
    expect(calls.count).toBe(1);
  }, 15000);

  it("surfaces a 503 carrying the sse_overload origin so the pool does not rotate accounts", async () => {
    const calls = { count: 0 };
    const result = await runAgainstOverload({
      overloadRetry: { budgetMs: 1, baseDelayMs: 1, maxDelayMs: 1, factor: 1, minRetries: 0, maxAttempts: 1, minSleepMs: 1 },
      calls,
    });
    expect(result.response.status).toBe(503);
    expect(result.response.__smUpstreamError?.origin).toBe("sse_overload");
  }, 15000);

  it("leaves a normal stream untouched", async () => {
    const executor = new CodexExecutor();
    const superExecute = vi.spyOn(Object.getPrototypeOf(CodexExecutor.prototype), "execute")
      .mockResolvedValue({ response: sse(OK_FRAME), url: "u", headers: {} });
    const result = await executor.execute({ model: "gpt-5.6-sol", body: {}, stream: true, credentials: {}, log: {} });
    superExecute.mockRestore();
    expect(result.response.status).toBe(200);
    await expect(result.response.text()).resolves.toContain("response.completed");
  }, 15000);

  // Overshoot guard: the budget used to be checked only AFTER an attempt returned,
  // so one slow attempt could run past the deadline (a p99 attempt measured 79s on
  // production; a 90s budget could stop at ~150s+, past the ~165s clients tolerate).
  // The scan is now bounded by the request deadline, and stopping there is reported
  // as UNRESOLVED rather than healthy — otherwise the scan would hand a possibly
  // overloaded stream to the client, which is the escape this path prevents.
  describe("attempt is bounded by the request deadline", () => {
    it("stops a stalled preamble scan at the deadline and answers 503", async () => {
      const executor = new CodexExecutor();
      executor.config = { ...executor.config, overloadRetry: { budgetMs: 300, baseDelayMs: 50, maxDelayMs: 50, factor: 1, minRetries: 0, maxAttempts: 5, minSleepMs: 1 } };
      // An upstream that sends `response.created` and then never speaks again: the
      // preamble scan would otherwise wait out its own (much longer) bound.
      const encoder = new TextEncoder();
      const stalled = new Response(new ReadableStream({
        start(c) {
          c.enqueue(encoder.encode('event: response.created\ndata: {"type":"response.created"}\n\n'));
          // never closes
        },
      }), { status: 200, headers: { "Content-Type": "text/event-stream" } });
      const superExecute = vi.spyOn(Object.getPrototypeOf(CodexExecutor.prototype), "execute")
        .mockResolvedValue({ response: stalled, url: "u", headers: {} });

      const started = Date.now();
      const result = await executor.execute({ model: "gpt-5.6-sol", body: {}, stream: true, credentials: {}, log: {} });
      const elapsed = Date.now() - started;
      superExecute.mockRestore();

      // Bounded by the 300ms budget, not the 60s preamble bound.
      expect(elapsed).toBeLessThan(5000);
      expect(result.response.status).toBe(503);
      expect(result.response.__smUpstreamError?.origin).toBe("sse_overload");
    }, 15000);

    it("a healthy stream is still released, not treated as unresolved", async () => {
      const executor = new CodexExecutor();
      const superExecute = vi.spyOn(Object.getPrototypeOf(CodexExecutor.prototype), "execute")
        .mockResolvedValue({ response: sse(OK_FRAME), url: "u", headers: {} });
      const result = await executor.execute({ model: "gpt-5.6-sol", body: {}, stream: true, credentials: {}, log: {} });
      superExecute.mockRestore();
      expect(result.response.status).toBe(200);
    }, 15000);
  });

  // The overload path must be legible from the log alone under LOG_LEVEL=WARN: an
  // operator has to see the detection, each backoff, and how it ended. Previously a
  // SUCCESSFUL retry logged nothing at all, so a recovered request was
  // indistinguishable from one that died mid-retry.
  describe("retry logging (WARN level, as production runs)", () => {
    async function runWithLog({ overloadRetry, recoverAfter, lines }) {
      const executor = new CodexExecutor();
      executor.config = { ...executor.config, overloadRetry };
      let n = 0;
      vi.spyOn(executor, "_peekSseTransientError").mockImplementation(async () => {
        n += 1;
        if (recoverAfter != null && n > recoverAfter) {
          return { matched: null, message: null, accountFallback: false, replacementBody: null };
        }
        return {
          matched: "server_is_overloaded",
          message: "Our servers are currently overloaded. Please try again later.",
          accountFallback: false,
          replacementBody: null,
          upstreamError: { source: "sse", status: 200, message: "overloaded", body: "", retryAfterMs: null },
        };
      });
      const superExecute = vi.spyOn(Object.getPrototypeOf(CodexExecutor.prototype), "execute")
        .mockResolvedValue({ response: sse(OVERLOAD_FRAME), url: "u", headers: {} });
      const result = await executor.execute({ model: "gpt-5.6-sol", body: {}, stream: true, credentials: {}, log: { warn: (t, m) => lines.push(`${t} ${m}`), debug: () => {} } });
      superExecute.mockRestore();
      return result;
    }

    it("logs detection, each backoff, and the recovery", async () => {
      const lines = [];
      await runWithLog({
        overloadRetry: { budgetMs: 5000, baseDelayMs: 5, maxDelayMs: 5, factor: 1, minRetries: 0, maxAttempts: 10, minSleepMs: 1 },
        recoverAfter: 2,
        lines,
      });
      const joined = lines.join("\n");
      expect(joined).toMatch(/SSE overloaded "server_is_overloaded" — retrying within a 5s budget/);
      expect(joined).toMatch(/retry 1 in \d+ms \(budget left/);
      expect(joined).toMatch(/retry 2 in \d+ms \(budget left/);
      expect(joined).toMatch(/recovered after 2 retries/);
    }, 15000);

    it("logs exhaustion with a readable duration", async () => {
      const lines = [];
      await runWithLog({
        overloadRetry: { budgetMs: 60, baseDelayMs: 5, maxDelayMs: 5, factor: 1, minRetries: 0, maxAttempts: 50, minSleepMs: 1 },
        recoverAfter: null,
        lines,
      });
      const joined = lines.join("\n");
      // Sub-second budgets must not render as "0s".
      expect(joined).toMatch(/retrying within a 60ms budget/);
      expect(joined).toMatch(/retries exhausted \(\d+ retries, 60ms budget\)/);
      // A successful-recovery line must NOT appear when it never recovered.
      expect(joined).not.toMatch(/recovered/);
    }, 15000);
  });
});

describe("request-wide overload budget", () => {
  it("is larger than one model's budget but below measured client patience", () => {
    // One model's budget must fit inside the request budget, and the request
    // budget must stay under the 165s TTFT Codex clients were observed to wait.
    expect(REQUEST_OVERLOAD_BUDGET_MS).toBeGreaterThan(DEFAULT_OVERLOAD_RETRY.budgetMs);
    expect(REQUEST_OVERLOAD_BUDGET_MS).toBeLessThanOrEqual(165_000);
  });
});

describe("channel strategy drives the retry curve", () => {
  it("lets a channel override each knob, leaving the rest at their defaults", () => {
    // The dashboard persists these on the channel's strategy entry; the executor
    // reads them off the credentials it is handed.
    const config = resolveOverloadRetryConfig({
      overloadRetryBudgetMs: 45_000,
      overloadRetryBaseDelayMs: 2_000,
    });
    expect(config.budgetMs).toBe(45_000);
    expect(config.baseDelayMs).toBe(2_000);
    // Untouched knobs keep the built-in values rather than being reset.
    expect(config.maxDelayMs).toBe(DEFAULT_OVERLOAD_RETRY.maxDelayMs);
    expect(config.minRetries).toBe(DEFAULT_OVERLOAD_RETRY.minRetries);
  });

  it("ignores malformed channel values instead of disabling retries", () => {
    const config = resolveOverloadRetryConfig({
      overloadRetryBudgetMs: 0,
      overloadRetryBaseDelayMs: "abc",
      overloadRetryMaxDelayMs: -5,
    });
    expect(config.budgetMs).toBe(DEFAULT_OVERLOAD_RETRY.budgetMs);
    expect(config.baseDelayMs).toBe(DEFAULT_OVERLOAD_RETRY.baseDelayMs);
    expect(config.maxDelayMs).toBe(DEFAULT_OVERLOAD_RETRY.maxDelayMs);
  });

  it("clamps a base delay above the ceiling so the curve stays monotonic", () => {
    const config = resolveOverloadRetryConfig({
      overloadRetryBaseDelayMs: 30_000,
      overloadRetryMaxDelayMs: 5_000,
    });
    expect(config.baseDelayMs).toBe(5_000);
    expect(resolveOverloadDelayMs(1, config)).toBeLessThanOrEqual(config.maxDelayMs);
    expect(resolveOverloadDelayMs(2, config)).toBeLessThanOrEqual(config.maxDelayMs);
  });

  it("lets the channel budget shorten the wait the executor actually takes", async () => {
    // End-to-end through the executor: a 200ms channel budget must stop the loop
    // quickly even though the built-in budget is 90s.
    const executor = new CodexExecutor();
    let calls = 0;
    vi.spyOn(executor, "_peekSseTransientError").mockImplementation(async () => {
      calls += 1;
      return {
        matched: "server_is_overloaded",
        message: "overloaded",
        accountFallback: false,
        replacementBody: null,
        upstreamError: { source: "sse", status: 200, message: "overloaded", body: "", retryAfterMs: null },
      };
    });
    const superExecute = vi.spyOn(Object.getPrototypeOf(CodexExecutor.prototype), "execute")
      .mockResolvedValue({ response: sse(OVERLOAD_FRAME), url: "u", headers: {} });

    const started = Date.now();
    const result = await executor.execute({
      model: "gpt-5.6-sol",
      body: {},
      stream: true,
      log: {},
      credentials: {
        providerStrategy: {
          overloadRetryBudgetMs: 300,
          overloadRetryBaseDelayMs: 50,
          overloadRetryMaxDelayMs: 50,
        },
      },
    });
    const elapsed = Date.now() - started;
    superExecute.mockRestore();

    expect(result.response.status).toBe(503);
    // Well under the 90s default — proves the channel value was applied.
    expect(elapsed).toBeLessThan(5_000);
    expect(calls).toBeGreaterThan(1);
  }, 15000);
});
