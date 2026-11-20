import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BACKOFF_CONFIG, QODER_LIMITS } from "../../open-sse/config/errorConfig.js";
import { classifyQoderLimit, qoderLimitCooldown } from "../../open-sse/shared/qoder/limits.js";
import { __test__ } from "../../open-sse/executors/qoder.js";

const db = vi.hoisted(() => ({ updateProviderConnectionHealth: vi.fn() }));
vi.mock("@/lib/localDb", () => db);
vi.mock("@/lib/network/connectionProxy", () => ({ resolveConnectionProxyConfig: vi.fn() }));
vi.mock("@/shared/constants/providers.js", () => ({ FREE_PROVIDERS: {}, resolveProviderId: p => p }));
vi.mock("@/sse/utils/logger.js", () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn() }));
const { markAccountUnavailable } = await import("../../src/sse/services/auth.js");

const start = Date.parse("2026-11-20T06:58:00Z");
const model = "dfmodel";
const lockKey = `modelLock_${model}`;
// Bodies exactly as recorded from the upstream.
const queueInner = { code: "10605", message: JSON.stringify({ isQueued: true, modelKey: model, queueCount: 0, queueType: "p3", retryAfterSeconds: 30, serviceAvailable: false, subCode: "RESOURCE_LIMIT", waitTime: 30 }), subCode: "RESOURCE_LIMIT" };
const queueBody = JSON.stringify({ code: "403", message: JSON.stringify(queueInner) });
const dailyBody = JSON.stringify({ code: 110, message: "Billing daily count exceeded" });
const quotaBody = JSON.stringify({ code: 112, message: JSON.stringify({ pricingUrl: "https://example.invalid/pricing" }) });

let account, now;
beforeEach(() => {
  now = start;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  account = { id: "fixture", provider: "qoder", name: "fixture", testStatus: "active" };
  db.updateProviderConnectionHealth.mockImplementation(async (_id, apply) => {
    const result = apply(account);
    Object.assign(account, result?.update);
    return result?.value;
  });
});
afterEach(() => vi.restoreAllMocks());

function fail(body, { provider = "qoder", status = 429, retryAfterMs = null, source = "sse" } = {}) {
  return markAccountUnavailable(account.id, status, body, provider, model, null, {
    status: 200, message: body, body, source, layer: "provider", retryAfterMs,
  });
}
const lockedForMs = () => Date.parse(account[lockKey]) - now;

describe("Qoder limit classification", () => {
  it("reads structured business codes through nested wrappers, for Qoder providers only", () => {
    expect(classifyQoderLimit("qoder-cn", queueBody)).toEqual({ kind: "queue" });
    expect(classifyQoderLimit("qoder", dailyBody)).toEqual({ kind: "dailyCount" });
    expect(classifyQoderLimit("qoder", quotaBody)).toEqual({ kind: "quota" });
    expect(classifyQoderLimit("workbuddy", queueBody)).toBeNull();
    expect(classifyQoderLimit("qoder", "Billing daily count exceeded 110")).toBeNull();
    expect(classifyQoderLimit("qoder", JSON.stringify({ code: 500 }))).toBeNull();
    expect(classifyQoderLimit("qoder", null)).toBeNull();
  });
  it("leaves quota and unknown limits to the shared policy", () => {
    expect(qoderLimitCooldown({ kind: "quota" })).toBeNull();
    expect(qoderLimitCooldown(null)).toBeNull();
  });
  it("surfaces the daily count cap as a usage limit rather than a 403", async () => {
    expect(__test__.isBillingBlock(dailyBody)).toBe(true);
    const frame = `data: ${JSON.stringify({ statusCodeValue: 403, body: dailyBody })}\n\n`;
    const stream = new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(frame)); c.close(); } }), { headers: { "content-type": "text/event-stream" } });
    const result = await __test__.wrapQoderSSE(stream, "qoder/dfmodel");
    expect(result.status).toBe(429);
    expect((await result.json()).error).toMatchObject({ code: 110, type: "rate_limit_error" });
    expect(result.__smUpstreamError).toMatchObject({ source: "sse", status: 200, body: dailyBody });
  });
});

describe("Qoder daily count cap", () => {
  it("locks the model for the bounded daily-count cooldown instead of the two-minute 403 rule", async () => {
    const result = await fail(dailyBody);
    expect(result).toMatchObject({ shouldFallback: true, cooldownMs: QODER_LIMITS.dailyCountCooldownMs });
    expect(lockedForMs()).toBe(QODER_LIMITS.dailyCountCooldownMs);
    expect(account.testStatus).toBe("limited");
    expect(account.testStatusUntil).toBe(account[lockKey]);
    expect(account.modelLock___all).toBeUndefined();
    expect(account.lastUpstreamRaw).toBe(dailyBody);
  });
  it("does not escalate, and does not shorten an existing later lock", async () => {
    account.backoffLevel = 3;
    await fail(dailyBody);
    expect(account.backoffLevel).toBe(3);
    const later = new Date(now + 2 * QODER_LIMITS.dailyCountCooldownMs).toISOString();
    account[lockKey] = later;
    await fail(dailyBody);
    expect(account[lockKey]).toBe(later);
  });
});

describe("Qoder persistent queue", () => {
  it("honours the upstream hint first, then doubles each consecutive probe up to the cap", async () => {
    const seen = [];
    for (let i = 0; i < 9; i++) {
      const result = await fail(queueBody, { retryAfterMs: 30_000 });
      expect(result.shouldFallback).toBe(true);
      expect(lockedForMs()).toBe(result.cooldownMs);
      seen.push(result.cooldownMs);
      now += result.cooldownMs + 1; // the next probe happens only after the lock expires
    }
    expect(seen.slice(0, 6)).toEqual([30_000, 60_000, 120_000, 240_000, 480_000, 960_000]);
    expect(seen.slice(6)).toEqual([QODER_LIMITS.queueMaxCooldownMs, QODER_LIMITS.queueMaxCooldownMs, QODER_LIMITS.queueMaxCooldownMs]);
    expect(account.testStatus).toBe("limited");
    expect(account.backoffLevel).toBeLessThanOrEqual(BACKOFF_CONFIG.maxLevel);
  });
  it("counts overlapping failures from one wave as a single round", async () => {
    const first = await fail(queueBody, { retryAfterMs: 30_000 });
    const lock = account[lockKey];
    now += 5_000;
    const second = await fail(queueBody, { retryAfterMs: 30_000 });
    expect(second.cooldownMs).toBe(first.cooldownMs - 5_000);
    expect(account[lockKey]).toBe(lock);
    expect(account.backoffLevel).toBe(1);
  });
  it("falls back to the configured base when the response carries no hint", async () => {
    expect((await fail(queueBody)).cooldownMs).toBe(QODER_LIMITS.queueBaseCooldownMs);
  });
  it("never exceeds the cap for an oversized hint or a corrupt level", () => {
    expect(qoderLimitCooldown({ kind: "queue" }, { retryAfterMs: 6 * 3_600_000 }).cooldownMs).toBe(QODER_LIMITS.queueMaxCooldownMs);
    const corrupt = qoderLimitCooldown({ kind: "queue" }, { retryAfterMs: 30_000, backoffLevel: 9999 });
    expect(corrupt).toEqual({ cooldownMs: QODER_LIMITS.queueMaxCooldownMs, newBackoffLevel: BACKOFF_CONFIG.maxLevel });
    expect(qoderLimitCooldown({ kind: "queue" }, { retryAfterMs: 30_000, backoffLevel: -4 }).cooldownMs).toBe(30_000);
  });
  it("applies to both Qoder channels and to no other provider", async () => {
    expect((await fail(queueBody, { provider: "qoder-cn", retryAfterMs: 30_000 })).cooldownMs).toBe(30_000);
    account = { id: "fixture", provider: "other", name: "fixture", testStatus: "active", backoffLevel: 4 };
    // Another provider keeps the plain upstream hint, with no escalation.
    const other = await fail(queueBody, { provider: "other", retryAfterMs: 30_000 });
    expect(other.cooldownMs).toBe(30_000);
    expect(account.backoffLevel).toBe(0);
  });
});

describe("Qoder quota (112)", () => {
  it("keeps the shared 429 exponential backoff", async () => {
    const result = await fail(quotaBody);
    expect(result).toMatchObject({ shouldFallback: true, cooldownMs: BACKOFF_CONFIG.base });
    expect(account.backoffLevel).toBe(1);
  });
});
