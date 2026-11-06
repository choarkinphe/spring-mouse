import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";

const mocks = vi.hoisted(() => ({
  servers: [],
  save: vi.fn(),
  exists: vi.fn(() => false),
}));
vi.mock("@/models", () => ({ createProviderConnection: mocks.save }));
vi.mock("open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: (...args) => globalThis.fetch(...args) }));
vi.mock("node:fs", () => ({ existsSync: mocks.exists }));
vi.mock("node:http", () => ({ default: {
  createServer(handler) {
    const server = new EventEmitter();
    Object.assign(server, {
      handler,
      listen: vi.fn((_port, _host, callback) => { callback(); return server; }),
      address: () => ({ port: 43210 }),
      close: vi.fn(), closeIdleConnections: vi.fn(), unref: vi.fn(),
    });
    mocks.servers.push(server);
    return server;
  },
} }));

import devin from "@/lib/oauth/providers/devin.js";
import {
  beginDevinSession, pollDevinSession, completeDevinSession, cancelDevinSession,
  DEVIN_SESSION_TTL_MS,
} from "@/lib/oauth/utils/devinServer.js";
import { GET, POST } from "@/app/api/oauth/devin/[action]/route.js";

const sessions = [];
let fetchMock;
const response = (data, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => data });
// Exact statusOf("b@x.dev", "TEAMS_TIER_DEVIN_PRO") fixture from upstream
// identity.test.mjs at 749e9dd12a5401cc11a701b7598c7ce32fcd7259.
const profile = { userStatus: { name: "b", email: "b@x.dev", teamsTier: "TEAMS_TIER_DEVIN_PRO", planStatus: { planInfo: { planName: "Pro" } } } };
async function begin(mode = "manual") {
  const data = await beginDevinSession({ mode });
  sessions.push(data.state);
  return data;
}
function successResponses(token = "opaque-fixture-token") {
  fetchMock.mockResolvedValueOnce(response({ sessionToken: token }))
    .mockResolvedValueOnce(response(profile));
}
async function callback(auth, query, headers = {}, method = "GET") {
  const server = mocks.servers.at(-1);
  const redirect = new URL(new URL(auth.authUrl).searchParams.get("redirect_uri"));
  const res = { writeHead: vi.fn(), end: vi.fn() };
  await server.handler({ url: `/callback?${query}`, method, headers: { host: redirect.host, ...headers } }, res);
  // The HTTP listener intentionally doesn't return the async handler promise.
  await vi.waitFor(() => expect(res.end).toHaveBeenCalled());
  return res;
}
function callbackQuery(auth, overrides = {}) {
  return new URLSearchParams({ state: new URL(auth.authUrl).searchParams.get("state"), code: "fixture-code", ...overrides }).toString();
}
function post(action, body, options = {}) {
  const url = options.url || `http://localhost:8008/api/oauth/devin/${action}`;
  return POST(new Request(url, { method: "POST", headers: { "Content-Type": "application/json", ...options.headers }, body: JSON.stringify(body) }), { params: Promise.resolve({ action }) });
}
function pollRoute(state) {
  return GET(new Request(`http://localhost:8008/api/oauth/devin/poll-status?state=${state}`), { params: Promise.resolve({ action: "poll-status" }) });
}

beforeEach(() => {
  fetchMock = vi.fn(() => { throw new Error("Unmocked network request"); });
  vi.stubGlobal("fetch", fetchMock);
  mocks.save.mockReset().mockImplementation(async (data) => ({ ...data, id: "fixture-connection" }));
  mocks.exists.mockReset().mockReturnValue(false);
  mocks.servers.length = 0;
});
afterEach(() => {
  for (const id of sessions.splice(0)) cancelDevinSession(id);
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("Devin PKCE provider contract", () => {
  it("builds CLI-compatible browser and headless URLs", () => {
    const url = new URL(devin.buildAuthUrl(devin.config, "http://127.0.0.1:43210/callback", "s/+", "c/+"));
    expect(url.origin + url.pathname).toBe("https://app.devin.ai/auth/cli/continue");
    expect(Object.fromEntries(url.searchParams)).toEqual({ redirect_uri: "http://127.0.0.1:43210/callback", state: "s/+", prompt: "select_account", code_challenge: "c/+", code_challenge_method: "S256", cli_pkce_marker: "1" });
    const manual = new URL(devin.buildAuthUrl(devin.config, null, "state", "challenge"));
    expect(manual.searchParams.get("cli_pkce_marker")).toBe("1");
    expect(manual.searchParams.has("redirect_uri")).toBe(false);
  });

  it.each(["opaque-session-fixture", "eyJ.fixture.jwt", "devin-session-token$fixture"])("preserves raw persistent token %s", async (token) => {
    successResponses(token);
    const tokens = await devin.exchangeToken(devin.config, "fixture-code", null, "fixture-verifier");
    const extra = await devin.postExchange(tokens);
    const mapped = devin.mapTokens(tokens, extra);
    expect(mapped.accessToken).toBe(token);
    expect(mapped).not.toHaveProperty("refreshToken");
    expect(mapped).not.toHaveProperty("expiresIn");
    expect(mapped).not.toHaveProperty("expiresAt");
    expect(mapped.providerSpecificData).toEqual({ authMethod: "oauth", userName: "b@x.dev", plan: "Devin Pro" });
    expect(JSON.stringify(mapped)).not.toContain("must-not-persist");
    const [tokenUrl, options] = fetchMock.mock.calls[0];
    expect(tokenUrl).toBe("https://server.codeium.com/exa.seat_management_pb.SeatManagementService/ExchangeDevinCLIPKCECode");
    expect(JSON.parse(options.body)).toEqual({ code: "fixture-code", code_verifier: "fixture-verifier", redirect_uri: "" });
    expect(options).toMatchObject({ method: "POST", redirect: "error", cache: "no-store", signal: expect.any(AbortSignal) });
    expect(fetchMock.mock.calls[1].slice(0, 2)).toMatchObject(["https://server.codeium.com/exa.seat_management_pb.SeatManagementService/GetUserStatus", { method: "POST", headers: { "Content-Type": "application/json", "Connect-Protocol-Version": "1" } }]);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).metadata).toMatchObject({ ideName: "devin-cli", ideVersion: "3000.11.3", extensionName: "devin-cli", extensionVersion: "3000.11.3", apiKey: token.startsWith("eyJ") ? `devin-session-token$${token}` : token, locale: "en" });
  });

  it.each([{}, { sessionToken: "" }, { sessionToken: 123 }, { sessionToken: "bad\nheader" }])("rejects malformed token response %j", async (data) => {
    fetchMock.mockResolvedValueOnce(response(data));
    await expect(devin.exchangeToken(devin.config, "code", null, "verifier")).rejects.toThrow("Devin token exchange failed");
  });

  it("accepts the CLI auth token field and still validates account identity", async () => {
    const auth = await begin();
    fetchMock.mockResolvedValueOnce(response({ token: "devin-session-token$fixture-token-field" }))
      .mockResolvedValueOnce(response(profile));
    await completeDevinSession(auth.state, "fixture-code");
    expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({ accessToken: "devin-session-token$fixture-token-field", provider: "devin", authType: "oauth" }));
  });
  it("accepts upstream snake_case exchange session token and binds browser redirect URI", async () => {
    fetchMock.mockResolvedValueOnce(response({ session_token: "devin-session-token$fixture", devinWebappHost: "app.devin.ai", devinApiUrl: "https://api.devin.ai" }));
    const redirect = "http://127.0.0.1:43210/callback";
    const tokens = await devin.exchangeToken(devin.config, "code", redirect, "verifier");
    expect(tokens).toEqual({ token: "devin-session-token$fixture", devinWebappHost: "app.devin.ai", devinApiUrl: "https://api.devin.ai" });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ code: "code", code_verifier: "verifier", redirect_uri: redirect });
  });

  it("does not save an exchange token explicitly refused by GetUserStatus", async () => {
    const auth = await begin();
    fetchMock.mockResolvedValueOnce(response({ sessionToken: "devin-session-token$fixture" }))
      .mockResolvedValueOnce(response({ code: "unauthenticated", message: "invalid api key" }, 401));
    await expect(completeDevinSession(auth.state, "code")).rejects.toThrow("Devin account validation failed");
    expect(mocks.save).not.toHaveBeenCalled();
    expect(pollDevinSession(auth.state).status).toBe("error");
  });

  it("uses organization identity as the OAuth dedup discriminator", () => {
    const a = devin.mapTokens({ token: "token-1" }, { userName: "m@x.dev · opt", email: "m@x.dev", orgId: "org_1", teamId: "devin-team$account-1", plan: "Devin Max" });
    const b = devin.mapTokens({ token: "token-2" }, { userName: "m@x.dev · lab", email: "m@x.dev", orgId: "org_2", teamId: "devin-team$account-2", plan: "Devin Max" });
    expect(a.email).toBe(b.email);
    expect(a.providerSpecificData.username).toBe("org_1");
    expect(b.providerSpecificData.username).toBe("org_2");
  });

  it("preserves safe exchange HTTP/code diagnostics without leaking response data", async () => {
    fetchMock.mockResolvedValueOnce(response({ code: "unauthenticated", message: "secret-token-code-verifier" }, 401));
    const error = await devin.exchangeToken(devin.config, "code", null, "verifier").catch(e => e);
    expect(error.status).toBe(401);
    expect(error.message).toContain("HTTP 401, unauthenticated");
    expect(error.message).not.toContain("secret-token-code-verifier");
    fetchMock.mockResolvedValueOnce(response({ code: "secret-arbitrary-code" }, 403));
    await expect(devin.exchangeToken(devin.config, "code", null, "verifier")).rejects.not.toThrow("secret-arbitrary-code");
  });
  it("redacts upstream exchange errors and treats profile errors as optional", async () => {
    fetchMock.mockRejectedValueOnce(new Error("secret-fixture-token"));
    await expect(devin.exchangeToken(devin.config, "code", null, "verifier")).rejects.not.toThrow("secret-fixture-token");
    fetchMock.mockResolvedValueOnce(response({ token: "secret-fixture-token" }, 401));
    await expect(devin.exchangeToken(devin.config, "code", null, "verifier")).rejects.toThrow("Devin token exchange failed");
    fetchMock.mockRejectedValueOnce(new Error("secret-fixture-token"));
    expect(await devin.postExchange({ token: "token" })).toBeNull();
    expect(devin.mapTokens({ token: "token" }, null)).toEqual({ accessToken: "token", providerSpecificData: { authMethod: "oauth" } });
  });
});

describe("Devin server-owned login sessions", () => {
  it("keeps verifier server-side and saves OAuth credentials without invented expiry", async () => {
    const auth = await begin();
    expect(auth).not.toHaveProperty("codeVerifier");
    expect(auth).not.toHaveProperty("redirectUri");
    expect(pollDevinSession(auth.state)).toEqual({ status: "pending" });
    successResponses();
    const result = await completeDevinSession(auth.state, " fixture-code ");
    expect(result).toEqual({ id: "fixture-connection", provider: "devin" });
    const verifier = JSON.parse(fetchMock.mock.calls[0][1].body).code_verifier;
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{64}$/);
    expect(createHash("sha256").update(verifier).digest("base64url")).toBe(new URL(auth.authUrl).searchParams.get("code_challenge"));
    expect(mocks.save).toHaveBeenCalledWith({ provider: "devin", authType: "oauth", accessToken: "opaque-fixture-token", email: "b@x.dev", displayName: "b@x.dev", providerSpecificData: { authMethod: "oauth", userName: "b@x.dev", plan: "Devin Pro" }, testStatus: "active" });
    await expect(completeDevinSession(auth.state, "another-code")).rejects.toThrow("already consumed");
    expect(pollDevinSession(auth.state)).toEqual({ status: "done" });
    expect(() => pollDevinSession(auth.state)).toThrow("not found");
  });

  it("rejects concurrent manual exchange without reusing verifier", async () => {
    const auth = await begin();
    let resolve;
    fetchMock.mockImplementationOnce(() => new Promise((r) => { resolve = r; }));
    const pending = completeDevinSession(auth.state, "code");
    await expect(completeDevinSession(auth.state, "code")).rejects.toThrow("already consumed");
    expect(pollDevinSession(auth.state)).toEqual({ status: "exchanging" });
    fetchMock.mockResolvedValueOnce(response(profile));
    resolve(response({ sessionToken: "opaque-fixture-token" }));
    await pending;
    expect(mocks.save).toHaveBeenCalledTimes(1);
  });

  it("binds only random IPv4 loopback, validates callback, and saves once", async () => {
    const auth = await begin("local");
    const server = mocks.servers[0];
    expect(server.listen).toHaveBeenCalledWith(0, "127.0.0.1", expect.any(Function));
    expect(new URL(auth.authUrl).searchParams.get("state")).not.toBe(auth.state);
    successResponses();
    const res = await callback(auth, callbackQuery(auth));
    expect(res.writeHead).toHaveBeenCalledWith(200, expect.objectContaining({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" }));
    expect(server.close).toHaveBeenCalled();
    expect(pollDevinSession(auth.state)).toEqual({ status: "done" });
    const replay = await callback(auth, callbackQuery(auth));
    expect(replay.writeHead.mock.calls[0][0]).toBe(404);
    expect(mocks.save).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(res.end.mock.calls)).not.toContain("opaque-fixture-token");
  });

  it.each([
    ["wrong state", { state: "wrong" }], ["missing state", { state: "" }],
    ["missing code", { code: "" }], ["denied", { error: "access_denied", error_description: "secret-code" }],
  ])("rejects %s and clears session secrets", async (_name, overrides) => {
    const auth = await begin("local");
    const res = await callback(auth, callbackQuery(auth, overrides));
    expect(res.writeHead.mock.calls[0][0]).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.save).not.toHaveBeenCalled();
    expect(pollDevinSession(auth.state).status).toBe("error");
    expect(() => pollDevinSession(auth.state)).toThrow("not found");
    expect(JSON.stringify(res.end.mock.calls)).not.toContain("secret-code");
    expect(mocks.servers[0].close).toHaveBeenCalled();
  });

  it.each([{ origin: "https://attacker.invalid" }, { host: "attacker.invalid" }])("rejects cross-origin/dns-rebinding callbacks %j", async (headers) => {
    const auth = await begin("local");
    const res = await callback(auth, callbackQuery(auth), headers);
    expect(res.writeHead.mock.calls[0][0]).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(pollDevinSession(auth.state)).toEqual({ status: "pending" });
  });

  it("rejects duplicate state and code parameters", async () => {
    const auth = await begin("local");
    await callback(auth, `${callbackQuery(auth)}&code=duplicate`);
    expect(pollDevinSession(auth.state).status).toBe("error");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects missing and duplicate callback state without network requests", async () => {
    const noState = await begin("local");
    await callback(noState, "code=fixture-code");
    expect(pollDevinSession(noState.state).status).toBe("error");
    const duplicate = await begin("local");
    await callback(duplicate, `${callbackQuery(duplicate)}&state=duplicate`);
    expect(pollDevinSession(duplicate.state).status).toBe("error");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects non-GET callbacks without consuming the session", async () => {
    const auth = await begin("local");
    const res = await callback(auth, callbackQuery(auth), {}, "POST");
    expect(res.writeHead.mock.calls[0][0]).toBe(405);
    expect(pollDevinSession(auth.state).status).toBe("pending");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("caps pending login sessions and frees capacity after cancellation", async () => {
    for (let i = 0; i < 20; i++) await begin();
    await expect(beginDevinSession()).rejects.toMatchObject({ status: 429 });
    cancelDevinSession(sessions[0]);
    const next = await begin();
    expect(pollDevinSession(next.state)).toEqual({ status: "pending" });
  });

  it("does not allow raw code completion for local sessions", async () => {
    const auth = await begin("local");
    await expect(completeDevinSession(auth.state, "code")).rejects.toThrow("manual-code mode");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("clears verifier and reports safe errors on save failure", async () => {
    const auth = await begin();
    successResponses();
    mocks.save.mockRejectedValueOnce(new Error("secret-db-fixture"));
    await expect(completeDevinSession(auth.state, "code")).rejects.not.toThrow("secret-db-fixture");
    expect(pollDevinSession(auth.state)).toEqual({ status: "error", error: "Devin account could not be saved; retry authorization" });
    expect(() => pollDevinSession(auth.state)).toThrow("not found");
  });

  it("expires sessions and closes listeners even when nobody polls", async () => {
    vi.useFakeTimers();
    try {
      const auth = await begin("local");
      await vi.advanceTimersByTimeAsync(DEVIN_SESSION_TTL_MS + 1);
      expect(() => pollDevinSession(auth.state)).toThrow("not found");
      expect(mocks.servers[0].close).toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  it("aborts cancelled exchanges without saving after the response arrives", async () => {
    const auth = await begin();
    let resolve;
    fetchMock.mockImplementationOnce(() => new Promise((r) => { resolve = r; }));
    const pending = completeDevinSession(auth.state, "code");
    cancelDevinSession(auth.state);
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
    fetchMock.mockResolvedValueOnce(response(profile));
    resolve(response({ sessionToken: "token-fixture" }));
    await expect(pending).rejects.toThrow("cancelled or expired");
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it.each(["", "https://example.invalid/?code=x", "code with spaces"])("rejects malformed manual code %s", async (input) => {
    const auth = await begin();
    await expect(completeDevinSession(auth.state, input)).rejects.toThrow();
    expect(pollDevinSession(auth.state).status).toBe("error");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("Devin static Next route", () => {
  it("supports manual begin/complete/poll with no secrets in responses", async () => {
    const beginRes = await post("begin", { mode: "manual", codeVerifier: "attacker-verifier" });
    const auth = await beginRes.json();
    sessions.push(auth.state);
    expect(beginRes.headers.get("Cache-Control")).toBe("no-store");
    expect(auth).toMatchObject({ mode: "manual", expiresIn: 600 });
    successResponses();
    const complete = await post("complete", { state: auth.state, code: "code" });
    expect(await complete.json()).toEqual({ success: true, connection: { id: "fixture-connection", provider: "devin" } });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).code_verifier).not.toBe("attacker-verifier");
    expect(await (await pollRoute(auth.state)).json()).toEqual({ status: "done" });
    expect((await pollRoute(auth.state)).status).toBe(404);
  });

  it.each(["https://remote.example.invalid", "http://192.0.2.1:8008"])("uses headless login on remote dashboard %s", async (origin) => {
    const res = await post("begin", { mode: "local" }, { url: `${origin}/api/oauth/devin/begin` });
    const auth = await res.json();
    sessions.push(auth.state);
    expect(auth.mode).toBe("manual");
    expect(new URL(auth.authUrl).searchParams.has("redirect_uri")).toBe(false);
    expect(mocks.servers).toHaveLength(0);
  });

  it("uses manual login inside a localhost-published container", async () => {
    mocks.exists.mockReturnValue(true);
    const auth = await (await post("begin", { mode: "local" })).json();
    sessions.push(auth.state);
    expect(auth.mode).toBe("manual");
    expect(mocks.servers).toHaveLength(0);
  });

  it("allows local loopback and cancels its listener", async () => {
    const auth = await (await post("begin", { mode: "local" })).json();
    expect(auth.mode).toBe("local");
    expect((await post("cancel", { state: auth.state })).status).toBe(200);
    expect((await pollRoute(auth.state)).status).toBe(404);
    expect(mocks.servers[0].close).toHaveBeenCalled();
  });

  it("accepts browser-proven same-origin requests behind TLS and Host rewriting", async () => {
    const res = await post("begin", { mode: "manual" }, { url: "http://0.0.0.0:8008/api/oauth/devin/begin", headers: { Host: "internal:8008", Origin: "https://gateway.example.invalid", "Sec-Fetch-Site": "same-origin", "X-Forwarded-Host": "ignored.invalid" } });
    expect(res.status).toBe(200);
    const auth = await res.json();
    sessions.push(auth.state);
    expect(auth.mode).toBe("manual");
    const denied = await post("begin", {}, { headers: { Origin: "https://attacker.invalid", "X-Forwarded-Host": "attacker.invalid", "X-Forwarded-Proto": "https" } });
    expect(denied.status).toBe(403);
    const sameSite = await post("begin", {}, { headers: { Origin: "http://localhost:8008", "Sec-Fetch-Site": "same-site" } });
    expect(sameSite.status).toBe(403);
  });
  it("rejects browser cross-origin mutation requests", async () => {
    const res = await post("begin", {}, { headers: { Origin: "https://attacker.invalid" } });
    expect(res.status).toBe(403);
    const wrongScheme = await post("begin", {}, { headers: { Origin: "https://localhost:8008" } });
    expect(wrongScheme.status).toBe(403);
    const sameHostCrossSite = await post("begin", {}, { headers: { "Sec-Fetch-Site": "cross-site" } });
    expect(sameHostCrossSite.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects invalid modes and unknown actions without falling through to generic exchange", async () => {
    expect((await post("begin", { mode: "arbitrary" })).status).toBe(400);
    expect((await post("exchange", { code: "eyJ.secret.fixture" })).status).toBe(400);
    expect((await post("complete", { state: "unknown", code: "code" })).status).toBe(404);
    expect(mocks.save).not.toHaveBeenCalled();
  });
});
