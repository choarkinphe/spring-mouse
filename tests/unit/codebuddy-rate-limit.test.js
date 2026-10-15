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
const { markAccountUnavailable } = await import("../../src/sse/services/auth.js");

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
