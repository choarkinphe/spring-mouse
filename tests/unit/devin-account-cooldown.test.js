import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEVIN } from "../../open-sse/config/devin.js";
import { MAX_RATE_LIMIT_COOLDOWN_MS } from "../../open-sse/config/errorConfig.js";

const db = vi.hoisted(() => ({ updateProviderConnectionHealth: vi.fn() }));
vi.mock("@/lib/localDb", () => db);
vi.mock("@/lib/network/connectionProxy", () => ({ resolveConnectionProxyConfig: vi.fn() }));
vi.mock("@/shared/constants/providers.js", () => ({ FREE_PROVIDERS: {}, resolveProviderId: p => p }));
vi.mock("@/sse/utils/logger.js", () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn() }));
const { markAccountUnavailable } = await import("../../src/sse/services/auth.js");
const now = Date.parse("2026-11-13T08:14:00Z");
const message = "Devin upstream error (resource_exhausted): Reached free model rate limit. Your limit will reset in 1 hour 45 minutes (at 10:01 UTC).";
let account;
beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(now);
  account = { id: "fixture", provider: "devin", name: "fixture", testStatus: "active", backoffLevel: 15 };
  db.updateProviderConnectionHealth.mockImplementation(async (_id, apply) => {
    const result = apply(account);
    Object.assign(account, result?.update);
    return result?.value;
  });
});
afterEach(() => vi.restoreAllMocks());

async function fail(text = message, { provider = "devin", status = 429, resetsAtMs = null, model = "swe-2" } = {}) {
  return markAccountUnavailable(account.id, status, text, provider, model, resetsAtMs, {
    status, message: text, body: JSON.stringify({ error: { message: text } }), source: "http", layer: "provider",
  });
}

describe("Devin account quota cooldown", () => {
  it.each([null, Date.parse("2026-11-13T10:01:00Z")])("locks until the upstream UTC reset, not 5 or 30 minutes (%s)", async resetsAtMs => {
    const result = await fail(message, { resetsAtMs });
    expect(result).toMatchObject({ shouldFallback: true, cooldownMs: 6_420_000 });
    expect(account["modelLock_swe-2"]).toBe("2026-11-13T10:01:00.000Z");
    expect(account.testStatusUntil).toBe(account["modelLock_swe-2"]);
    expect(account.testStatus).toBe("limited");
    expect(account.backoffLevel).toBe(0);
    expect(account.modelLock___all).toBeUndefined();
  });
  it("applies the same lock to late SSE quota errors without replaying output", async () => {
    await markAccountUnavailable(account.id, 429, message, "devin", "swe-2", null, { source: "sse", status: 429, message, layer: "provider" });
    expect(account["modelLock_swe-2"]).toBe("2026-11-13T10:01:00.000Z");
    expect(account.lastUpstreamSource).toBe("sse");
  });
  it("keeps the generic reset cap for other providers", async () => {
    const result = await fail(message, { provider: "other", resetsAtMs: now + DEVIN.maxQuotaCooldownMs });
    expect(result.cooldownMs).toBe(MAX_RATE_LIMIT_COOLDOWN_MS);
  });
  it("does not apply the longer quota cap to arbitrary structured reset hints", async () => {
    expect((await fail("rate limit", { resetsAtMs: now + DEVIN.maxQuotaCooldownMs })).cooldownMs).toBe(MAX_RATE_LIMIT_COOLDOWN_MS);
  });
  it("keeps generic exponential backoff for missing or invalid reset times", async () => {
    const result = await fail("rate limit. Your limit will reset in 999 hours.");
    expect(result.cooldownMs).toBe(300_000);
  });
  it("does not shorten an existing later model lock", async () => {
    account["modelLock_swe-2"] = "2026-11-13T11:00:00.000Z";
    await fail();
    expect(account["modelLock_swe-2"]).toBe("2026-11-13T11:00:00.000Z");
  });
});

describe("Devin weekly quota exhaustion", () => {
  const exhausted = "Devin upstream error (failed_precondition): Your weekly usage quota has been exhausted. Visit https://app.devin.ai/settings/usage to purchase on-demand usage or turn on auto-reload.";
  it("locks the metered model for a bounded hour instead of the 5-minute 429 backoff", async () => {
    const result = await fail(exhausted, { model: "claude-opus-5-5" });
    expect(result).toMatchObject({ shouldFallback: true, cooldownMs: DEVIN.weeklyQuotaCooldownMs });
    expect(account["modelLock_claude-opus-5-5"]).toBe(new Date(now + DEVIN.weeklyQuotaCooldownMs).toISOString());
    expect(account.testStatus).toBe("limited");
    expect(account.backoffLevel).toBe(0);
    // Free models must keep serving on the same account.
    expect(account.modelLock___all).toBeUndefined();
    expect(account["modelLock_swe-2"]).toBeUndefined();
  });
  it("still rotates when the same message arrives as a failed_precondition trailer", async () => {
    const result = await fail(exhausted, { model: "claude-opus-5-5", status: 400 });
    expect(result).toMatchObject({ shouldFallback: true, cooldownMs: DEVIN.weeklyQuotaCooldownMs });
  });
  it("does not treat other rejected requests as quota exhaustion", async () => {
    const result = await fail("Devin upstream error (invalid_argument): There is an issue with this request, please try a different model.", { status: 400 });
    expect(result).toMatchObject({ shouldFallback: false, cooldownMs: 0 });
    expect(account["modelLock_swe-2"]).toBeUndefined();
  });
  it("is a Devin-only policy", async () => {
    expect((await fail(exhausted, { provider: "other" })).cooldownMs).not.toBe(DEVIN.weeklyQuotaCooldownMs);
  });
});
