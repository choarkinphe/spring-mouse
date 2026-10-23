import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CodeBuddyIntlExecutor } from "../../open-sse/executors/codebuddy-intl.js";
import { CodeBuddyExecutor } from "../../open-sse/executors/codebuddy-cn.js";
import { parseUpstreamError } from "../../open-sse/utils/error.js";
import { isModelLockActive } from "../../open-sse/services/accountFallback.js";

const db = vi.hoisted(() => ({
  updateProviderConnectionHealth: vi.fn(),
}));
vi.mock("@/lib/localDb", () => db);
vi.mock("@/lib/network/connectionProxy", () => ({ resolveConnectionProxyConfig: vi.fn() }));
vi.mock("@/shared/constants/providers.js", () => ({ FREE_PROVIDERS: {}, resolveProviderId: (p) => p }));
vi.mock("@/sse/utils/logger.js", () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn() }));
const { markAccountUnavailable, clearAccountError } = await import("../../src/sse/services/auth.js");

let executor;
let provider;
const quota = (time) => ({ code: 6004, msg: `usage exceeds frequency limit, but don't worry, your usage will reset at ${time}, alternatively, you can switch to the other models to continue using it.` });
const throttle = { code: 14003, msg: "too many requests", displayTips: { en: "Wait about a minute before retrying, or switch to a less busy model." } };
const parse = (body, status = 429, headers = {}) => parseUpstreamError(new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers }), executor);
let account;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-14T07:50:00.000Z"));
  account = { id: "cb", backoffLevel: 0 };
  db.updateProviderConnectionHealth.mockImplementation(async (_id, update) => {
    const result = update(account);
    Object.assign(account, result?.update);
    return result?.value;
  });
});
afterEach(() => vi.useRealTimers());

async function lock(parsed) {
  return markAccountUnavailable("cb", parsed.statusCode, parsed.message, provider, "deepseek-v4.1-flash", parsed.resetsAtMs, parsed.upstreamError);
}

describe("CodeBuddy intl channel verification rejection", () => {
  beforeEach(() => { provider = "codebuddy-intl"; executor = new CodeBuddyIntlExecutor(); });

  it.each([11128, "11128"])("temporarily locks only the account for structured code %s, preserving evidence", async (code) => {
    const body = { code, msg: "channel verification failed" };
    const parsed = await parse(body, 400);
    const result = await lock(parsed);
    expect(result).toMatchObject({ shouldFallback: true, cooldownMs: 300000, modelLevel: false });
    expect(result.accountScoped).toBeUndefined(); // reserved for header-timeout telemetry
    expect(parsed.statusCode).toBe(400);
    expect(account).toMatchObject({
      modelLock___all: "2026-10-14T07:55:00.000Z",
      testStatus: "unavailable", testStatusUntil: "2026-10-14T07:55:00.000Z",
      lastUpstreamStatus: 400, errorCode: 400, lastUpstreamRaw: JSON.stringify(body),
      lastUpstreamDiagnostics: parsed.upstreamError.diagnostics,
      backoffLevel: 0,
    });
    expect(account.isActive).toBeUndefined();
    // An expired model lock must not shadow the still-active account lock.
    account.modelLock_other = "2026-10-14T07:49:59.000Z";
    expect(isModelLockActive(account, "other")).toBe(true);
    expect(isModelLockActive(account, "unrelated-model")).toBe(true);
    vi.advanceTimersByTime(300000);
    expect(isModelLockActive(account, "other")).toBe(false);
    expect(isModelLockActive(account, "unrelated-model")).toBe(false);
  });

  it.each([
    { msg: "channel verification failed: 11128" },
    { code: 11115, msg: "context too long: 11128" },
    { code: "011128", msg: "not the exact code" },
    { error: { code: 11128 } },
    [{ code: 11128 }],
    "11128",
    "invalid JSON: 11128",
  ])("does not quarantine generic/context/nonmatching 400 errors: %j", async (body) => {
    expect((await lock(await parse(body, 400))).shouldFallback).toBe(false);
    expect(account.modelLock___all).toBeUndefined();
    expect(account.testStatus).toBeUndefined();
  });

  it("does not let a stale success erase a newer verification block", async () => {
    const credentials = { _routingStartedAt: Date.now(), _connection: { ...account } };
    vi.advanceTimersByTime(1000);
    await lock(await parse({ code: 11128, msg: "channel verification failed" }, 400));
    await clearAccountError("cb", credentials, "deepseek-v4.1-flash");
    expect(account.testStatus).toBe("unavailable");
    expect(account.lastUpstreamStatus).toBe(400);
    expect(isModelLockActive(account, "any-model")).toBe(true);
  });

  it("does not apply intl verification policy to another provider", async () => {
    provider = "codebuddy-cn";
    executor = new CodeBuddyExecutor();
    expect((await lock(await parse({ code: 11128 }, 400))).shouldFallback).toBe(false);
    expect(account.modelLock___all).toBeUndefined();
  });

  it("requires original upstream HTTP 400 evidence", async () => {
    const parsed = await parse({ code: 11128 }, 400);
    for (const evidence of [null, { ...parsed.upstreamError, source: "sse" }, { ...parsed.upstreamError, status: 200 }]) {
      expect((await markAccountUnavailable("cb", 400, parsed.message, provider, "other", null, evidence)).shouldFallback).toBe(false);
    }
    expect(account.modelLock___all).toBeUndefined();
  });
});

describe.each([["codebuddy-intl", CodeBuddyIntlExecutor], ["codebuddy-cn", CodeBuddyExecutor]])("%s production rate-limit responses", (providerId, Executor) => {
  beforeEach(() => { provider = providerId; executor = new Executor(); });
  it("locks to the explicit UTC+8 quota reset, without disabling the account", async () => {
    const parsed = await parse(quota("2026-10-14 16:00:01 UTC+8"));
    expect(parsed.resetsAtMs).toBe(Date.parse("2026-10-14T08:00:01Z"));
    expect((await lock(parsed)).cooldownMs).toBe(601000);
    expect(account["modelLock_deepseek-v4.1-flash"]).toBe("2026-10-14T08:00:01.000Z");
    expect(account.isActive).toBeUndefined();
    expect(account.modelLock___all).toBeUndefined();
    expect(isModelLockActive(account, "deepseek-v4.1-flash")).toBe(true);
    expect(isModelLockActive(account, "another-model")).toBe(false);
    vi.setSystemTime(new Date("2026-10-14T08:00:01.000Z"));
    expect(isModelLockActive(account, "deepseek-v4.1-flash")).toBe(false);
  });

  it("keeps the existing 30-minute cap for a distant quota reset", async () => {
    expect((await lock(await parse(quota("2026-10-14 17:10:42 UTC+8")))).cooldownMs).toBe(1800000);
  });

  it("waits a minute on 14003 rather than retrying after two seconds", async () => {
    const parsed = await parse(throttle);
    expect(parsed.upstreamError.retryAfterMs).toBe(60000);
    expect((await lock(parsed)).cooldownMs).toBe(60000);
    expect(parsed.upstreamError.body).toBe(JSON.stringify(throttle));
  });

  it("honors a longer HTTP Retry-After", async () => {
    expect((await lock(await parse(throttle, 429, { "Retry-After": "120" }))).cooldownMs).toBe(120000);
  });

  it("retains the provider's minimum delay over a shorter header", async () => {
    expect((await lock(await parse(throttle, 429, { "Retry-After": "2" }))).cooldownMs).toBe(60000);
  });

  it.each(["invalid", "2026-10-14 15:00:01 UTC+8"])("falls back to bounded backoff for an unusable reset: %s", async (time) => {
    expect((await lock(await parse(quota(time)))).cooldownMs).toBe(2000);
  });

  it.each(["<html>upstream error</html>", { code: 9999, msg: "unknown limit" }])("preserves unknown errors and existing backoff", async (body) => {
    expect((await lock(await parse(body))).cooldownMs).toBe(2000);
  });

  it("does not retry a 400 context-length rejection across accounts", async () => {
    const parsed = await parse({ code: 11115, msg: "prompt is too long: 6573434 tokens > 1048576 maximum" }, 400);
    expect(parsed.statusCode).toBe(400);
    expect((await lock(parsed)).shouldFallback).toBe(false);
  });
});
