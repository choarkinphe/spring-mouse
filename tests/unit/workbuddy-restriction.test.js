import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isWorkBuddyRestriction } from "../../open-sse/shared/workbuddyRestriction.js";
import { shouldRefreshCredentials } from "../../open-sse/services/oauthCredentialManager.js";
import { selectConnectionsNeedingRefresh } from "../../src/sse/services/backgroundTokenRefresh.js";
import { observeWorkBuddyRestriction } from "../../open-sse/utils/workbuddyRestrictionStream.js";
import { guardOpenAIFirstOutput } from "../../open-sse/utils/openaiFirstOutput.js";
import { parseSSEToOpenAIResponse } from "../../open-sse/handlers/chatCore/sseToJsonHandler.js";
import { checkAndRefreshToken } from "../../src/sse/services/tokenRefresh.js";

const db = vi.hoisted(() => ({ updateProviderConnectionHealth: vi.fn() }));
vi.mock("@/lib/localDb", () => db);
vi.mock("@/lib/network/connectionProxy", () => ({ resolveConnectionProxyConfig: vi.fn() }));
vi.mock("@/shared/constants/providers.js", () => ({ FREE_PROVIDERS: {}, resolveProviderId: p => p }));
vi.mock("@/sse/utils/logger.js", () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn() }));
const { markAccountUnavailable, clearAccountError } = await import("../../src/sse/services/auth.js");
const providers = ["workbuddy", "workbuddy-ai", "codebuddy-cn", "codebuddy-intl"];
const payload = { code: 11140, msg: "request illegal", retry_policy: { retry: false } };
let account;
beforeEach(() => {
  account = { id: "wb", provider: "workbuddy", isActive: true };
  db.updateProviderConnectionHealth.mockImplementation(async (_id, updater) => {
    const result = updater(account);
    Object.assign(account, result?.update);
    return result?.value;
  });
});
afterEach(() => vi.useRealTimers());

describe("WorkBuddy restriction evidence", () => {
  it.each(providers)("matches only structured business codes for %s", provider => {
    for (const body of [payload, { code: "11140" }, { error: { code: 11140 } }, { data: { code: 11140 } }, { error: { data: { code: 11140 } } }]) {
      expect(isWorkBuddyRestriction(provider, body)).toBe(true);
      expect(isWorkBuddyRestriction(provider, JSON.stringify(body))).toBe(true);
    }
    for (const body of [{ message: "11140" }, { code: 11128 }, { code: "011140" }, [payload], "bad JSON", null]) {
      expect(isWorkBuddyRestriction(provider, body)).toBe(false);
    }
    expect(isWorkBuddyRestriction("codex", payload)).toBe(false);
  });

  it.each(providers)("persistently disables %s across models and ignores late successes/errors", async provider => {
    account.provider = provider;
    const body = JSON.stringify(payload);
    const evidence = { source: "http", status: 403, body, message: "restricted", receivedAt: new Date().toISOString() };
    const result = await markAccountUnavailable("wb", 403, body, provider, "model-a", null, evidence);
    expect(result).toMatchObject({ restricted: true, shouldFallback: true, cooldownMs: 0 });
    expect(account).toMatchObject({ isActive: false, accountRestriction: { code: 11140 }, testStatusUntil: null, lastUpstreamRaw: body });
    expect(Object.keys(account).some(k => k.startsWith("modelLock_"))).toBe(false);
    const saved = structuredClone(account);
    vi.useFakeTimers(); vi.advanceTimersByTime(86400000);
    await clearAccountError("wb", {}, "different-model");
    await markAccountUnavailable("wb", 429, "quota", provider, "different-model", null, { source: "http", status: 429, body: "{}" });
    expect(account).toEqual(saved);
  });

  it("does not treat local error text as upstream evidence", async () => {
    await markAccountUnavailable("wb", 403, JSON.stringify(payload), "workbuddy", "model", null, null);
    expect(account.accountRestriction).toBeUndefined();
  });

  it("skips proactive, forced and background refresh even when expired", async () => {
    const restricted = { provider: "workbuddy", authType: "oauth", refreshToken: "test", expiresAt: "2020-01-01", accountRestriction: { code: 11140 } };
    const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("must not contact upstream"));
    expect(await checkAndRefreshToken("workbuddy", restricted, { force: true })).toBe(restricted);
    expect(network).not.toHaveBeenCalled();
    network.mockRestore();
    expect(shouldRefreshCredentials("workbuddy", restricted)).toBe(false);
    const legacy = { ...restricted, accountRestriction: null, providerSpecificData: { workbuddyLegacyCredential: true } };
    expect(await checkAndRefreshToken("workbuddy", legacy, { force: true })).toBe(legacy);
    expect(selectConnectionsNeedingRefresh([restricted, legacy, { ...restricted, accountRestriction: null, isActive: false }])).toEqual([]);
  });
});

describe.each(providers)("%s SSE restriction", provider => {
  it.each([false, true])("records and normalizes restriction after visible output=%s", async visible => {
    const output = 'data: {"choices":[{"delta":{"content":"hello"}}]}\n\n';
    const notify = vi.fn(async () => {});
    const raw = new Response((visible ? output : ": heartbeat\n\n") + `data: ${JSON.stringify(payload)}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
    const watched = observeWorkBuddyRestriction(raw, provider, notify);
    const guarded = await guardOpenAIFirstOutput(watched, { provider, deadlineMs: Date.now() + 5000 });
    if (!visible) {
      expect(guarded.status).toBe(403);
      expect(guarded.__smUpstreamError.source).toBe("sse");
    }
    const text = await guarded.text();
    expect(notify).toHaveBeenCalledOnce();
    expect(notify.mock.calls[0][0]).toMatchObject({ status: 403, upstreamError: { source: "sse", status: 200, body: JSON.stringify(payload) } });
    if (visible) expect(parseSSEToOpenAIResponse(text, "model")).toMatchObject({ error: { code: 11140, status: 403 } });
    expect(text).toContain("11140");
  });
});
