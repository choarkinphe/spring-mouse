import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The provider accepts config as an argument. Avoid importing the full registry
// merely to supply defaults, and block the proxy/refresh import side effects.
vi.mock("@/lib/oauth/constants/oauth.js", () => ({ CODEBUDDY_CONFIG: {} }));
vi.mock("open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: () => { throw new Error("Unexpected proxy initialization/call"); },
}));
vi.mock("open-sse/services/tokenRefresh.js", () => ({
  refreshCodebuddyToken: () => { throw new Error("Unexpected token refresh"); },
}));

import provider from "@/lib/oauth/providers/codebuddy-cn.js";

const config = {
  stateUrl: "https://codebuddy.invalid/v2/plugin/auth/state",
  tokenUrl: "https://codebuddy.invalid/v2/plugin/auth/token",
  baseUrl: "https://codebuddy.invalid", userAgent: "UnitTestOAuth/1", pollInterval: 2000,
};
const response = (body, ok = true) => ({ ok, json: vi.fn().mockResolvedValue(body), text: vi.fn().mockResolvedValue("state unavailable") });
let fetchMock;

beforeEach(() => {
  fetchMock = vi.fn(() => { throw new Error("Unexpected unmocked network request"); });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("CodeBuddy WorkBuddy browser OAuth", () => {
  it("requests a WorkBuddy platform state and carries exactly that state through GET polling and account lookup", async () => {
    const state = "same state/+?&=中文";
    fetchMock
      .mockResolvedValueOnce(response({ code: 0, data: { state, authUrl: "https://login.invalid/authorize" } }))
      .mockResolvedValueOnce(response({ code: 0, data: { accessToken: "chat-access", refreshToken: "chat-refresh", expiresIn: 7200, tokenType: "Bearer" } }))
      .mockResolvedValueOnce(response({ code: 0, data: { uid: "workbuddy-uid" } }));
    const device = await provider.requestDeviceCode(config);
    expect(device).toEqual({ device_code: state, verification_uri: "https://login.invalid/authorize", user_code: "", interval: 2, _isCodeBuddy: true });
    expect(fetchMock.mock.calls[0]).toEqual([`${config.stateUrl}?platform=workbuddy`, expect.objectContaining({
      method: "POST", body: "{}", headers: expect.objectContaining({
        "Content-Type": "application/json", "X-No-Authorization": "true", "X-No-User-Id": "true", "X-Product": "SaaS",
      }),
    })]);
    const tokens = await provider.pollToken(config, device.device_code);
    expect(tokens).toEqual({ ok: true, data: { access_token: "chat-access", refresh_token: "chat-refresh", token_type: "Bearer", expires_in: 7200, codebuddy_uid: "workbuddy-uid" } });
    const [tokenUrl, tokenOptions] = fetchMock.mock.calls[1];
    const [accountUrl, accountOptions] = fetchMock.mock.calls[2];
    expect(tokenUrl).toBe(`${config.tokenUrl}?state=${encodeURIComponent(state)}`);
    expect(tokenOptions).toMatchObject({ method: "GET", headers: { Accept: "application/json", "X-No-Authorization": "true" } });
    expect(tokenOptions).not.toHaveProperty("body");
    expect(accountUrl).toBe(`${config.baseUrl}/v2/plugin/login/account?state=${encodeURIComponent(state)}`);
    // Omitted method is fetch's GET default, not a POST with a fabricated state.
    expect(accountOptions.method ?? "GET").toBe("GET");
    expect(accountOptions).not.toHaveProperty("body");
    expect(accountOptions).toMatchObject({ redirect: "error", signal: expect.any(AbortSignal), headers: {
      Authorization: "Bearer chat-access", "User-Agent": "WorkBuddy/5.5.6", "X-No-User-Id": "true", "X-No-Enterprise-Id": "true",
    } });
    expect(provider.mapTokens(tokens.data)).toEqual({
      accessToken: "chat-access", refreshToken: "chat-refresh", expiresIn: 7200, providerSpecificData: { codebuddyUid: "workbuddy-uid" },
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it.each([123456, "00123456"])("persists the account UID as a string (%s)", async (uid) => {
    fetchMock.mockResolvedValueOnce(response({ code: 0, data: { accessToken: "access" } }))
      .mockResolvedValueOnce(response({ code: 0, data: { uid } }));
    const result = await provider.pollToken(config, "original-state");
    expect(result.data.codebuddy_uid).toBe(String(uid));
    expect(provider.mapTokens(result.data).providerSpecificData).toEqual({ codebuddyUid: String(uid) });
  });

  it.each([
    ["missing UID", { code: 0, data: {} }, true],
    ["null UID", { code: 0, data: { uid: null } }, true],
    ["object UID", { code: 0, data: { uid: { value: "not-an-id" } } }, true],
    ["boolean UID", { code: 0, data: { uid: true } }, true],
    ["account business failure", { code: 1002, data: { uid: "ignore" } }, true],
    ["account HTTP failure", { code: 0, data: { uid: "ignore" } }, false],
  ])("does not break chat credentials when account lookup has %s", async (_name, body, ok) => {
    fetchMock.mockResolvedValueOnce(response({ code: 0, data: { accessToken: "valid-chat-access", refreshToken: "valid-chat-refresh", expiresIn: 3600 } }))
      .mockResolvedValueOnce(response(body, ok));
    const result = await provider.pollToken(config, "state");
    expect(result).toMatchObject({ ok: true, data: { access_token: "valid-chat-access", refresh_token: "valid-chat-refresh", codebuddy_uid: null } });
    expect(provider.mapTokens(result.data)).toEqual({ accessToken: "valid-chat-access", refreshToken: "valid-chat-refresh", expiresIn: 3600, providerSpecificData: {} });
  });

  it.each(["timeout", "invalid JSON"])("keeps chat credentials if optional account lookup fails with %s", async (failure) => {
    fetchMock.mockResolvedValueOnce(response({ code: 0, data: { accessToken: "valid-access" } }));
    if (failure === "timeout") fetchMock.mockRejectedValueOnce(new DOMException("private payload", "TimeoutError"));
    else fetchMock.mockResolvedValueOnce({ ok: true, json: vi.fn().mockRejectedValue(new SyntaxError("private payload")) });
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const result = await provider.pollToken(config, "state");
    expect(timeout).toHaveBeenCalledWith(15_000);
    expect(result).toEqual({ ok: true, data: { access_token: "valid-access", refresh_token: "", token_type: "Bearer", expires_in: undefined, codebuddy_uid: null } });
    expect(provider.mapTokens(result.data)).toEqual({ accessToken: "valid-access", refreshToken: "", expiresIn: 86400, providerSpecificData: {} });
    expect(JSON.stringify(result)).not.toContain("private payload");
  });

  it("returns pending without looking up an account", async () => {
    fetchMock.mockResolvedValueOnce(response({ code: 11217 }));
    expect(await provider.pollToken(config, "pending-state")).toEqual({ ok: true, data: { error: "authorization_pending" } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns request_failed on HTTP polling failure without account lookup", async () => {
    fetchMock.mockResolvedValueOnce(response({}, false));
    expect(await provider.pollToken(config, "state")).toEqual({ ok: false, data: { error: "request_failed" } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    [{ code: 9001, msg: "denied" }, "denied"],
    [{ code: 0, data: {} }, "unknown_error"],
  ])("does not look up an account without an access token (%j)", async (body, error) => {
    fetchMock.mockResolvedValueOnce(response(body));
    expect(await provider.pollToken(config, "state")).toEqual({ ok: false, data: { error } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    { code: 1, msg: "invalid platform" },
    { code: 0, data: { state: "state" } },
    { code: 0, data: { authUrl: "https://login.invalid" } },
  ])("rejects a state response missing a usable state/auth URL (%j)", async (body) => {
    fetchMock.mockResolvedValueOnce(response(body));
    await expect(provider.requestDeviceCode(config)).rejects.toThrow("CodeBuddy state error:");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects failed state requests", async () => {
    fetchMock.mockResolvedValueOnce(response({}, false));
    await expect(provider.requestDeviceCode(config)).rejects.toThrow("CodeBuddy state request failed:");
  });
});
