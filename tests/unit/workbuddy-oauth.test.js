import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWorkBuddyOAuthHandler } from "@/lib/oauth/providers/workbuddy.js";

const NOW = 1800000000000;
const sites = [
  ["https://copilot.tencent.com", "workbuddy"],
  ["https://www.workbuddy.ai", "workbuddy-ai"],
];
const configFor = (origin, platform) => ({
  origin, platform, productId: platform,
  stateUrl: `${origin}/v2/plugin/auth/state`, tokenUrl: `${origin}/v2/plugin/auth/token`,
  refreshUrl: `${origin}/v2/plugin/auth/token/refresh`, pollInterval: 2000,
});
const config = configFor(...sites[0]);
const response = (body, ok = true) => ({ ok, json: vi.fn().mockResolvedValue(body) });
const token = (extra = {}) => ({ code: 0, data: {
  accessToken: "opaque-access-token", refreshToken: "opaque-refresh-token", expiresIn: 7200,
  tokenType: "Bearer", refreshExpiresAt: NOW + 86400000, ...extra,
} });
const account = (extra = {}) => ({ code: 0, data: { uid: "00123", nickname: "Tester", ...extra } });
let fetchMock;
beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  fetchMock = vi.fn(() => { throw new Error("Unmocked fetch"); });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function expectPending(result) {
  expect(result).toEqual({ ok: true, data: { error: "authorization_pending" } });
  expect(result.data).not.toHaveProperty("access_token");
}

describe("WorkBuddy browser OAuth contract", () => {
  it.each([{ type: "enterprise" }, { enterpriseId: {} }, { enterpriseId: "" }])("does not downgrade ambiguous enterprise identity to personal access: %j", async (identity) => {
    const handler = createWorkBuddyOAuthHandler(config);
    fetchMock.mockResolvedValueOnce(response(token())).mockResolvedValueOnce(response(account(identity)));
    expect(await handler.pollToken(handler.config, "fixture-state")).toEqual({ ok: false, data: { error: "invalid_account_enterprise" } });
  });
  it.each(sites)("completes same-state auth for %s using honest headers", async (origin, platform) => {
    const cfg = configFor(origin, platform);
    const handler = createWorkBuddyOAuthHandler(cfg);
    const state = "same state/+?&=中文";
    fetchMock.mockResolvedValueOnce(response({ code: 0, data: { state, authUrl: `${origin}/login?state=hello` } }))
      .mockResolvedValueOnce(response(token({ domain: new URL(origin).hostname })))
      .mockResolvedValueOnce(response(account({ enterpriseId: "enterprise-42", email: "person@example.com", type: "enterprise" })));
    const device = await handler.requestDeviceCode(handler.config);
    expect(device).toEqual({ device_code: state, verification_uri: `${origin}/login?state=hello`, user_code: "", expires_in: 300, interval: 2, _isCodeBuddy: true, _isWorkBuddy: true });
    const result = await handler.pollToken(handler.config, state);
    expect(result.ok).toBe(true);
    expect(handler.mapTokens(result.data)).toEqual({
      accessToken: "opaque-access-token", refreshToken: "opaque-refresh-token", expiresIn: 7200,
      displayName: "Tester", email: "person@example.com",
      providerSpecificData: {
        workbuddyProduct: platform, workbuddyOrigin: origin, workbuddyPlatform: platform,
        workbuddyContract: "0.1.30", codebuddyUid: "00123", domain: new URL(origin).hostname,
        refreshExpiresAt: NOW + 86400000, tokenType: "Bearer", enterpriseId: "enterprise-42",
        tenantId: "enterprise-42", tenantVerified: true,
      },
    });
    const [stateUrl, stateOptions] = fetchMock.mock.calls[0];
    expect(stateUrl).toBe(`${cfg.stateUrl}?platform=${platform}`);
    expect(stateOptions).toMatchObject({ method: "POST", body: "{}", headers: { "Content-Type": "application/json", "X-No-Authorization": "true", "X-No-User-Id": "true" } });
    const [tokenUrl, tokenOptions] = fetchMock.mock.calls[1];
    const [accountUrl, accountOptions] = fetchMock.mock.calls[2];
    expect(new URL(tokenUrl).searchParams.get("state")).toBe(state);
    expect(new URL(accountUrl).searchParams.get("state")).toBe(state);
    expect(new URL(accountUrl).pathname).toBe("/v2/plugin/login/account");
    expect(tokenOptions).toMatchObject({ method: "GET", headers: { "X-No-Authorization": "true" } });
    expect(accountOptions).toMatchObject({ method: "GET", headers: { Authorization: "Bearer opaque-access-token" } });
    expect(accountOptions.headers).not.toHaveProperty("X-No-Authorization");
    const timeout = vi.spyOn(AbortSignal, "timeout");
    fetchMock.mockResolvedValueOnce(response({ code: 11217 }));
    await handler.pollToken(handler.config, "another-state");
    expect(timeout).toHaveBeenCalledWith(30000);
    for (const [, options] of fetchMock.mock.calls) {
      expect(options).toMatchObject({ redirect: "error", cache: "no-store", signal: expect.any(AbortSignal) });
      expect(options.headers["User-Agent"]).toContain("Spring-Mouse");
      expect(options.headers["User-Agent"]).not.toMatch(/^WorkBuddy\//);
      expect(options.headers["X-Domain"]).toBe(new URL(origin).hostname);
      expect(options.headers).not.toHaveProperty("X-IDE-Type");
      expect(options.headers).not.toHaveProperty("X-User-Id");
      expect(options.headers).not.toHaveProperty("X-Enterprise-Id");
    }
  });

  it("keeps token pending until account is ready, then reuses the original state and token", async () => {
    const handler = createWorkBuddyOAuthHandler(config);
    fetchMock.mockResolvedValueOnce(response({ code: 11217 }))
      .mockResolvedValueOnce(response(token()))
      .mockResolvedValueOnce(response({ code: 12151, data: { accessToken: "must-not-leak" } }))
      .mockResolvedValueOnce(response({ code: 12151 }))
      .mockResolvedValueOnce(response(account()));
    expectPending(await handler.pollToken(config, "same-state"));
    expectPending(await handler.pollToken(config, "same-state"));
    expectPending(await handler.pollToken(config, "same-state"));
    const result = await handler.pollToken(config, "same-state");
    expect(result.ok).toBe(true);
    expect(fetchMock.mock.calls.map(([url]) => new URL(url).pathname)).toEqual([
      "/v2/plugin/auth/token", "/v2/plugin/auth/token", "/v2/plugin/login/account", "/v2/plugin/login/account", "/v2/plugin/login/account",
    ]);
    expect(fetchMock.mock.calls.every(([url]) => new URL(url).searchParams.get("state") === "same-state")).toBe(true);
  });

  it.each([undefined, null, "", " ", {}, [], true, 0, -1, 1.1, Number.MAX_SAFE_INTEGER + 1, "x\r\ny"])("does not authorize without valid account UID %j", async (uid) => {
    const handler = createWorkBuddyOAuthHandler(config);
    fetchMock.mockResolvedValueOnce(response(token())).mockResolvedValueOnce(response(account({ uid })));
    const result = await handler.pollToken(config, "state");
    expect(result).toEqual({ ok: false, data: { error: "invalid_account_uid" } });
    expect(() => handler.mapTokens({ access_token: "access" })).toThrow("account UID");
  });

  it("uses account UID only, never decodes a JWT or treats nickname/phone as email", async () => {
    const handler = createWorkBuddyOAuthHandler(config);
    fetchMock.mockResolvedValueOnce(response(token({ accessToken: "header.eyJ1aWQiOiJmYWtlIn0.signature" })))
      .mockResolvedValueOnce(response(account({ uid: 123, nickname: "not-an-email", phoneNumber: "+123456789", email: "not-an-email" })));
    const mapped = handler.mapTokens((await handler.pollToken(config, "state")).data);
    expect(mapped.providerSpecificData.codebuddyUid).toBe("123");
    expect(mapped).not.toHaveProperty("email");
    expect(mapped.displayName).toBe("not-an-email");
  });

  it("does not mark an enterprise verified from token metadata alone", async () => {
    const handler = createWorkBuddyOAuthHandler(config);
    fetchMock.mockResolvedValueOnce(response(token({ enterpriseId: "unverified-tenant", tenantId: "unverified-tenant", tenantVerified: true })))
      .mockResolvedValueOnce(response(account({ type: "personal" })));
    const metadata = handler.mapTokens((await handler.pollToken(config, "state")).data).providerSpecificData;
    expect(metadata).not.toHaveProperty("enterpriseId");
    expect(metadata).not.toHaveProperty("tenantId");
    expect(metadata).not.toHaveProperty("tenantVerified");
  });

  it("converts expiresAt milliseconds to seconds and retains absolute refresh expiry", async () => {
    const handler = createWorkBuddyOAuthHandler(config);
    fetchMock.mockResolvedValueOnce(response(token({ expiresAt: NOW + 3600500, expiresIn: 99999 })))
      .mockResolvedValueOnce(response(account()));
    const result = await handler.pollToken(config, "state");
    expect(result.data.expires_in).toBe(3600);
    vi.mocked(Date.now).mockReturnValue(NOW + 10000);
    const mapped = handler.mapTokens(result.data);
    expect(mapped.expiresIn).toBe(3590);
    expect(mapped.providerSpecificData.refreshExpiresAt).toBe(NOW + 86400000);
  });

  it("preserves expiresIn and calculates relative refresh lifetime", async () => {
    const handler = createWorkBuddyOAuthHandler(config);
    fetchMock.mockResolvedValueOnce(response(token({ expiresIn: 1800, refreshExpiresAt: undefined, refreshExpiresIn: 7200 })))
      .mockResolvedValueOnce(response(account()));
    const mapped = handler.mapTokens((await handler.pollToken(config, "state")).data);
    expect(mapped.expiresIn).toBe(1800);
    expect(mapped.providerSpecificData.refreshExpiresAt).toBe(NOW + 7200000);
  });

  it.each([
    { expiresAt: NOW - 1000 }, { expiresAt: 1800003600 }, { expiresAt: "1800003600000" },
    { expiresIn: -1 }, { expiresIn: "3600" }, { refreshExpiresAt: -1 }, { tokenType: "secret-token" },
    { accessToken: {} }, { accessToken: "a\nb" }, { refreshToken: {} },
  ])("rejects ambiguous/bad token fields %j", async (extra) => {
    const handler = createWorkBuddyOAuthHandler(config);
    fetchMock.mockResolvedValueOnce(response(token(extra)));
    const result = await handler.pollToken(config, "state");
    expect(result.ok).toBe(false);
    expect(result.data).not.toHaveProperty("access_token");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each(["evil.example", "www.workbuddy.ai", "copilot.tencent.com.evil.example", "https://copilot.tencent.com", "copilot.tencent.com/path"])("rejects token-origin injection %s before account lookup", async (domain) => {
    const handler = createWorkBuddyOAuthHandler(config);
    fetchMock.mockResolvedValueOnce(response(token({ domain })));
    expect(await handler.pollToken(config, "state")).toEqual({ ok: false, data: { error: "invalid_token_domain" } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("ignores caller/extraData origin overrides and isolates pending state between products", async () => {
    const cn = createWorkBuddyOAuthHandler(config);
    const aiConfig = configFor(...sites[1]);
    const ai = createWorkBuddyOAuthHandler(aiConfig);
    fetchMock.mockResolvedValueOnce(response(token())).mockResolvedValueOnce(response({ code: 12151 }))
      .mockResolvedValueOnce(response({ code: 11217 }))
      .mockResolvedValueOnce(response(account()));
    expectPending(await cn.pollToken({ ...config, origin: "https://evil.example", tokenUrl: "https://evil.example" }, "shared", null, { origin: "https://evil.example" }));
    expectPending(await ai.pollToken(aiConfig, "shared"));
    const result = await cn.pollToken(config, "shared");
    expect(result.ok).toBe(true);
    expect(fetchMock.mock.calls.map(([url]) => new URL(url).origin)).toEqual([config.origin, config.origin, aiConfig.origin, config.origin]);
    expect(() => ai.mapTokens(result.data)).toThrow("invalid_token_domain");
  });

  it.each([
    { origin: "https://evil.example" }, { origin: "http://copilot.tencent.com" },
    { origin: "https://copilot.tencent.com/" }, { platform: "workbuddy-ai" },
    { stateUrl: "https://evil.example/state" }, { tokenUrl: "https://www.workbuddy.ai/token" },
    { refreshUrl: "https://copilot.tencent.com@evil.example/refresh" },
    { tokenUrl: `${config.tokenUrl}?state=private` }, { authUrlAllowedHosts: ["*.tencent.com"] },
    { authUrlAllowedHosts: ["login.tencent.com/path"] },
  ])("rejects unsafe configuration %j", (override) => {
    expect(() => createWorkBuddyOAuthHandler({ ...config, ...override })).toThrow("configuration is invalid");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    "http://copilot.tencent.com/login", "javascript:alert(1)", "https://evil.example/login",
    "https://copilot.tencent.com.evil.example/login", "https://copilot.tencent.com@evil.example/login",
    "https://user:password@copilot.tencent.com/login", "https://copilot.tencent.com:8443/login",
    "https://copilot.tencent.com\\@evil.example/login", "//copilot.tencent.com/login", "https://www.workbuddy.ai/login",
  ])("rejects unsafe login URL %s", async (authUrl) => {
    const handler = createWorkBuddyOAuthHandler(config);
    fetchMock.mockResolvedValueOnce(response({ code: 0, data: { state: "state", authUrl } }));
    await expect(handler.requestDeviceCode()).rejects.toThrow("invalid authorization response");
  });

  it("allows explicit legitimate login host without expanding trusted API hosts", async () => {
    const handler = createWorkBuddyOAuthHandler({ ...config, authUrlAllowedHosts: ["accounts.tencent.com"] });
    fetchMock.mockResolvedValueOnce(response({ code: 0, data: { state: "state", authUrl: "https://accounts.tencent.com/login" } }))
      .mockResolvedValueOnce(response(token())).mockResolvedValueOnce(response(account()));
    expect((await handler.requestDeviceCode()).verification_uri).toBe("https://accounts.tencent.com/login");
    const result = await handler.pollToken(config, "state");
    expect(handler.mapTokens(result.data).providerSpecificData.workbuddyOrigin).toBe(config.origin);
    expect(fetchMock.mock.calls.every(([url]) => new URL(url).origin === config.origin)).toBe(true);
  });

  it("returns only allowlisted metadata, without state or nested secrets", async () => {
    const handler = createWorkBuddyOAuthHandler(config);
    fetchMock.mockResolvedValueOnce(response(token({ state: "private-state", debug: "private-secret", providerSpecificData: { accessToken: "private-secret" } })))
      .mockResolvedValueOnce(response(account({ enterpriseId: "tenant-1", unknown: "private-secret", phoneNumber: "private-secret", state: "private-state" })));
    const mapped = handler.mapTokens((await handler.pollToken(config, "private-state")).data);
    expect(Object.keys(mapped.providerSpecificData).sort()).toEqual([
      "codebuddyUid", "domain", "enterpriseId", "refreshExpiresAt", "tenantId", "tenantVerified", "tokenType", "workbuddyContract", "workbuddyOrigin", "workbuddyPlatform", "workbuddyProduct",
    ]);
    expect(JSON.stringify(mapped.providerSpecificData)).not.toMatch(/private-secret|private-state|opaque-access|opaque-refresh/);
  });

  it.each(["http", "json", "network", "business", "account"])("sanitizes %s errors and never logs credentials", async (kind) => {
    const spies = ["log", "error", "warn", "info"].map((key) => vi.spyOn(console, key).mockImplementation(() => {}));
    const handler = createWorkBuddyOAuthHandler(config);
    const secret = "CREDENTIAL-SECRET";
    if (kind === "network") fetchMock.mockRejectedValueOnce(new Error(secret));
    else if (kind === "json") fetchMock.mockResolvedValueOnce({ ok: true, json: vi.fn().mockRejectedValue(new Error(secret)) });
    else if (kind === "account") fetchMock.mockResolvedValueOnce(response(token())).mockResolvedValueOnce(response({ code: 444, msg: secret }));
    else fetchMock.mockResolvedValueOnce(response({ code: 444, msg: secret, data: { accessToken: secret } }, kind !== "http"));
    const result = await handler.pollToken(config, "private-state");
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toMatch(/CREDENTIAL-SECRET|opaque-access|opaque-refresh|private-state/);
    spies.forEach((spy) => expect(spy).not.toHaveBeenCalled());
  });

  it.each([
    { code: 1, msg: "CREDENTIAL-SECRET" },
    { code: 0, data: {} },
    { code: 0, data: { state: "", authUrl: `${config.origin}/login` } },
    { code: 0, data: { state: "state" } },
    { code: 0, data: { state: {}, authUrl: `${config.origin}/login` } },
  ])("rejects incomplete state responses without echoing payload %j", async (body) => {
    const handler = createWorkBuddyOAuthHandler(config);
    fetchMock.mockResolvedValueOnce(response(body));
    await expect(handler.requestDeviceCode()).rejects.toThrow("WorkBuddy returned an invalid authorization response");
  });

  it("sanitizes failed state request without reading raw response text", async () => {
    const handler = createWorkBuddyOAuthHandler(config);
    const text = vi.fn().mockResolvedValue("CREDENTIAL-SECRET");
    fetchMock.mockResolvedValueOnce({ ok: false, text });
    await expect(handler.requestDeviceCode()).rejects.toThrow("request_failed");
    expect(text).not.toHaveBeenCalled();
  });

  it("expires transient account-pending credentials instead of retaining them indefinitely", async () => {
    const handler = createWorkBuddyOAuthHandler(config);
    fetchMock.mockResolvedValueOnce(response(token())).mockResolvedValueOnce(response({ code: 12151 }))
      .mockResolvedValueOnce(response({ code: 11217 }));
    expectPending(await handler.pollToken(config, "state"));
    vi.mocked(Date.now).mockReturnValue(NOW + 11 * 60000);
    expectPending(await handler.pollToken(config, "state"));
    expect(new URL(fetchMock.mock.calls[2][0]).pathname).toBe("/v2/plugin/auth/token");
  });
});
