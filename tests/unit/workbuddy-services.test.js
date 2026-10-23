import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { refreshWorkBuddyToken } from "open-sse/services/tokenRefresh/workbuddy.js";
import { discoverWorkBuddyModels, parseWorkBuddyModels } from "open-sse/services/workbuddyModels.js";
import { proxyAwareFetch } from "open-sse/utils/proxyFetch.js";

vi.mock("open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: vi.fn() }));

const NOW = 1800000000000;
const sites = [
  ["workbuddy", "https://copilot.tencent.com"],
  ["workbuddy-ai", "https://www.workbuddy.ai"],
];
let fixtureId = 0;
let log;

function credentials(provider = "workbuddy", origin = sites.find(([id]) => id === provider)[1]) {
  return {
    provider,
    accessToken: "fixture-old-access",
    // The real refresh deduplicator retains results briefly. Never reuse a key
    // across cases, and never wait for its production TTL to elapse.
    refreshToken: `fixture-refresh-${++fixtureId}`,
    providerSpecificData: {
      workbuddyProduct: provider, workbuddyOrigin: origin,
      workbuddyPlatform: provider, workbuddyContract: "0.1.30",
      codebuddyUid: "fixture-uid", domain: new URL(origin).hostname,
      tokenType: "Bearer", refreshExpiresAt: NOW + 86400000,
    },
  };
}

const response = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: vi.fn().mockResolvedValue(body) });
const tokenPayload = (extra = {}) => ({ code: 0, data: { accessToken: "fixture-new-access", refreshToken: "fixture-rotated-refresh", expiresIn: 3600, ...extra } });
const catalog = () => ({ code: 0, data: {
  agents: [{ name: "other", models: ["not-for-cli"] }, { name: "cli", models: ["model-b", { id: "model-a" }, "model-b"] }],
  models: [
    { id: "not-for-cli", name: "Other agent model" },
    { id: "model-a", name: "Model A", maxInputTokens: 128000, maxOutputTokens: 8192, supportsImages: true, supportsReasoning: false },
    { id: "model-b" },
  ],
} });

beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  vi.mocked(proxyAwareFetch).mockReset().mockRejectedValue(new Error("Unexpected mocked request"));
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Real network is forbidden in service tests"); }));
  log = { warn: vi.fn(), info: vi.fn(), error: vi.fn() };
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function expectNoSecrets(value, secrets) {
  const serialized = JSON.stringify(value);
  for (const secret of secrets) expect(serialized).not.toContain(secret);
}

describe("WorkBuddy refresh service", () => {
  it.each(sites)("refreshes %s only on its bound origin with proxy and verified account metadata", async (provider, origin) => {
    const saved = credentials(provider, origin);
    Object.assign(saved.providerSpecificData, { enterpriseId: "tenant-42", tenantId: "tenant-42", tenantVerified: true });
    const metadata = { ...saved.providerSpecificData };
    const proxy = { connectionProxyEnabled: true, connectionProxyUrl: "http://127.0.0.1:9876" };
    vi.mocked(proxyAwareFetch).mockResolvedValueOnce(response(tokenPayload({ domain: new URL(origin).hostname })));

    const result = await refreshWorkBuddyToken(provider, saved, log, proxy);

    expect(result).toEqual({ accessToken: "fixture-new-access", refreshToken: "fixture-rotated-refresh", expiresIn: 3600, providerSpecificData: metadata });
    expect(saved.providerSpecificData).toEqual(metadata);
    expect(proxyAwareFetch).toHaveBeenCalledTimes(1);
    expect(proxyAwareFetch).toHaveBeenCalledWith(`${origin}/v2/plugin/auth/token/refresh`, {
      method: "POST", body: "{}", signal: expect.any(AbortSignal), redirect: "error",
      headers: {
        "Content-Type": "application/json", Accept: "application/json", "User-Agent": "Spring-Mouse",
        "X-Product": "SaaS", "X-Domain": new URL(origin).hostname, "X-User-Id": "fixture-uid",
        "X-Enterprise-Id": "tenant-42", "X-Tenant-Id": "tenant-42",
        "X-Refresh-Token": saved.refreshToken, "X-Auth-Refresh-Source": "plugin",
      },
    }, proxy);
    expectNoSecrets(log.warn.mock.calls, [saved.accessToken, saved.refreshToken]);
  });

  it("isolates real deduplication by provider even for the same rotating refresh credential", async () => {
    const cn = credentials();
    const ai = credentials(...sites[1]);
    ai.refreshToken = cn.refreshToken;
    vi.mocked(proxyAwareFetch).mockResolvedValueOnce(response(tokenPayload({ accessToken: "cn-access" })))
      .mockResolvedValueOnce(response(tokenPayload({ accessToken: "ai-access" })));
    const [cnResult, aiResult] = await Promise.all([
      refreshWorkBuddyToken("workbuddy", cn, log), refreshWorkBuddyToken("workbuddy-ai", ai, log),
    ]);
    expect(cnResult.accessToken).toBe("cn-access");
    expect(aiResult.accessToken).toBe("ai-access");
    expect(proxyAwareFetch.mock.calls.map(([url]) => new URL(url).origin)).toEqual(sites.map(([, origin]) => origin));
  });

  it("converts absolute expiry milliseconds to seconds and preserves absolute refresh expiry", async () => {
    vi.mocked(proxyAwareFetch).mockResolvedValueOnce(response(tokenPayload({ expiresAt: NOW + 3600500, expiresIn: 99999, refreshExpiresAt: NOW + 7200123 })));
    const result = await refreshWorkBuddyToken("workbuddy", credentials(), log);
    expect(result.expiresIn).toBe(3600);
    expect(result.providerSpecificData.refreshExpiresAt).toBe(NOW + 7200123);
  });

  it("converts a relative refresh lifetime to absolute milliseconds", async () => {
    vi.mocked(proxyAwareFetch).mockResolvedValueOnce(response(tokenPayload({ expiresIn: 1800, refreshExpiresIn: 7200 })));
    const result = await refreshWorkBuddyToken("workbuddy", credentials(), log);
    expect(result.expiresIn).toBe(1800);
    expect(result.providerSpecificData.refreshExpiresAt).toBe(NOW + 7200000);
  });

  it("keeps the previous refresh token and expiry when rotation fields are absent", async () => {
    const saved = credentials();
    vi.mocked(proxyAwareFetch).mockResolvedValueOnce(response(tokenPayload({ refreshToken: undefined, expiresIn: undefined })));
    const result = await refreshWorkBuddyToken("workbuddy", saved, log);
    expect(result.refreshToken).toBe(saved.refreshToken);
    expect(result.expiresIn).toBe(86400);
    expect(result.providerSpecificData).toEqual(saved.providerSpecificData);
  });

  it("refuses an expired refresh credential without fetching", async () => {
    for (const expiresAt of [NOW, NOW - 1000]) {
      const saved = credentials();
      saved.providerSpecificData.refreshExpiresAt = expiresAt;
      expect(await refreshWorkBuddyToken("workbuddy", saved, log)).toEqual({ error: "invalid_grant" });
    }
    expect(proxyAwareFetch).not.toHaveBeenCalled();
  });

  it("returns null without fetching when no refresh token is saved", async () => {
    const saved = credentials();
    delete saved.refreshToken;
    expect(await refreshWorkBuddyToken("workbuddy", saved, log)).toBeNull();
    expect(proxyAwareFetch).not.toHaveBeenCalled();
  });

  it("rejects misbound origin/product/UID and unverified tenants before credentials leave the process", async () => {
    for (const override of [
      { workbuddyProduct: "workbuddy-ai" }, { workbuddyOrigin: "https://evil.example" },
      { domain: "www.workbuddy.ai" }, { workbuddyPlatform: "workbuddy-ai" },
      { workbuddyContract: undefined }, { codebuddyUid: undefined },
      { enterpriseId: "unverified", tenantId: "unverified" },
    ]) {
      const saved = credentials();
      Object.assign(saved.providerSpecificData, override);
      await expect(refreshWorkBuddyToken("workbuddy", saved, log)).rejects.toThrow(/WorkBuddy/);
    }
    expect(proxyAwareFetch).not.toHaveBeenCalled();
  });

  it("rejects malformed token responses and domain injection without leaking credentials", async () => {
    const badFields = [
      { accessToken: "" }, { accessToken: {} }, { accessToken: "bad\naccess" },
      { refreshToken: {} }, { refreshToken: "bad refresh" }, { tokenType: "Basic" },
      { domain: "www.workbuddy.ai" }, { domain: "copilot.tencent.com.evil.example" },
      { expiresAt: NOW - 1 }, { expiresAt: 1800003600 }, { refreshExpiresAt: NOW },
    ];
    for (const fields of badFields) {
      const saved = credentials();
      vi.mocked(proxyAwareFetch).mockResolvedValueOnce(response(tokenPayload(fields)));
      expect(await refreshWorkBuddyToken("workbuddy", saved, log)).toBeNull();
      expectNoSecrets(log.warn.mock.calls, [saved.accessToken, saved.refreshToken, "fixture-new-access"]);
    }
    expect(proxyAwareFetch).toHaveBeenCalledTimes(badFields.length);
  });

  it("rejects control characters in returned access and rotating refresh tokens", async () => {
    for (const fields of [{ accessToken: "access\u0000secret" }, { refreshToken: "refresh\u007fsecret" }]) {
      vi.mocked(proxyAwareFetch).mockResolvedValueOnce(response(tokenPayload(fields)));
      expect.soft(await refreshWorkBuddyToken("workbuddy", credentials(), log)).toBeNull();
    }
  });

  it("rejects ambiguous string-valued relative token lifetimes", async () => {
    for (const fields of [{ expiresIn: "3600" }, { refreshExpiresIn: "7200" }]) {
      vi.mocked(proxyAwareFetch).mockResolvedValueOnce(response(tokenPayload(fields)));
      expect.soft(await refreshWorkBuddyToken("workbuddy", credentials(), log)).toBeNull();
    }
  });

  it("maps HTTP authentication failure to invalid_grant and does not retry other HTTP errors", async () => {
    for (const status of [401, 403, 429, 503]) {
      vi.mocked(proxyAwareFetch).mockResolvedValueOnce(response({ msg: "server-secret" }, status));
      expect(await refreshWorkBuddyToken("workbuddy", credentials(), log)).toEqual(status === 401 || status === 403 ? { error: "invalid_grant" } : null);
    }
    expect(proxyAwareFetch).toHaveBeenCalledTimes(4);
    expectNoSecrets(log.warn.mock.calls, ["server-secret"]);
  });

  it("sanitizes network and JSON failures rather than logging upstream secrets", async () => {
    for (const kind of ["network", "json"]) {
      const saved = credentials();
      const error = new Error(`server-secret ${saved.accessToken} ${saved.refreshToken}`);
      if (kind === "network") vi.mocked(proxyAwareFetch).mockRejectedValueOnce(error);
      else vi.mocked(proxyAwareFetch).mockResolvedValueOnce({ ok: true, json: vi.fn().mockRejectedValue(error) });
      expect(await refreshWorkBuddyToken("workbuddy", saved, log)).toBeNull();
      expectNoSecrets(log.warn.mock.calls, ["server-secret", saved.accessToken, saved.refreshToken]);
    }
    expect(log.warn).toHaveBeenCalledTimes(2);
    expect(proxyAwareFetch).toHaveBeenCalledTimes(2);
  });

  it("never fails over to another site after business error 11128", async () => {
    vi.mocked(proxyAwareFetch).mockResolvedValueOnce(response({ code: 11128, msg: "private-upstream-message", data: { accessToken: "must-not-leak" } }));
    expect(await refreshWorkBuddyToken("workbuddy", credentials(), log)).toBeNull();
    expect(proxyAwareFetch).toHaveBeenCalledTimes(1);
    expect(proxyAwareFetch.mock.calls[0][0]).toBe(`${sites[0][1]}/v2/plugin/auth/token/refresh`);
    expectNoSecrets(log.warn.mock.calls, ["private-upstream-message", "must-not-leak"]);
  });
});

describe("WorkBuddy account catalog parsing", () => {
  it("joins CLI agent IDs to model records, deduplicates, and excludes other agents", () => {
    expect(parseWorkBuddyModels(catalog())).toEqual([
      { id: "model-b", name: "model-b", supportedFormats: ["openai"], capabilities: {} },
      { id: "model-a", name: "Model A", supportedFormats: ["openai"], contextWindow: 128000, maxOutputTokens: 8192, capabilities: { vision: true, reasoning: false } },
    ]);
  });

  it("rejects malformed envelopes or missing CLI model lists", () => {
    for (const body of [null, {}, { code: 11128 }, { code: "0", data: catalog().data },
      { code: 0, data: { agents: [], models: [] } },
      { code: 0, data: { agents: [{ name: "cli" }], models: [] } },
      { code: 0, data: { agents: {}, models: [] } },
      { code: 0, data: { agents: [{ name: "cli", models: [] }], models: {} } },
    ]) expect(() => parseWorkBuddyModels(body)).toThrow(/WorkBuddy/);
  });

  it("rejects incomplete joins and malformed CLI IDs instead of returning a partial catalog", () => {
    for (const id of ["unknown", null, {}, { id: 42 }]) {
      const body = catalog();
      body.data.agents[1].models.push(id);
      expect(() => parseWorkBuddyModels(body)).toThrow("Incomplete WorkBuddy account catalog");
    }
  });

  it("accepts an explicitly empty CLI model list as a valid empty account catalog", () => {
    const body = catalog();
    body.data.agents[1].models = [];
    expect(parseWorkBuddyModels(body)).toEqual([]);
  });
});

describe("WorkBuddy model discovery service", () => {
  it.each(sites)("discovers %s models from its own v3/config with bound identity and proxy", async (provider, origin) => {
    const saved = credentials(provider, origin);
    const proxy = { connectionProxyEnabled: true, connectionProxyUrl: "http://127.0.0.1:9876" };
    const body = catalog();
    vi.mocked(proxyAwareFetch).mockResolvedValueOnce(response(body));
    expect(await discoverWorkBuddyModels(saved, proxy)).toEqual({ models: parseWorkBuddyModels(body), listingScope: "account" });
    expect(proxyAwareFetch).toHaveBeenCalledTimes(1);
    expect(proxyAwareFetch).toHaveBeenCalledWith(`${origin}/v3/config`, {
      method: "GET", cache: "no-store", redirect: "error", signal: expect.any(AbortSignal),
      headers: {
        "Content-Type": "application/json", Accept: "application/json", "User-Agent": "Spring-Mouse",
        "X-Product": "SaaS", "X-Domain": new URL(origin).hostname,
        Authorization: "Bearer fixture-old-access", "X-User-Id": "fixture-uid",
      },
    }, proxy);
  });

  it("rejects cross-product credentials before discovery can send authorization", async () => {
    const saved = credentials();
    saved.provider = "workbuddy-ai";
    await expect(discoverWorkBuddyModels(saved)).rejects.toThrow(/mismatch/);
    expect(proxyAwareFetch).not.toHaveBeenCalled();
  });

  it("ignores caller origin/URL overrides and does not forward arbitrary identity headers", async () => {
    const saved = credentials();
    Object.assign(saved, { origin: "https://evil.example", baseUrl: "https://evil.example", rawHeaders: { Authorization: "foreign-secret", "X-User-Id": "foreign-user" } });
    Object.assign(saved.providerSpecificData, { origin: "https://evil.example", configUrl: "https://evil.example/v3/config" });
    vi.mocked(proxyAwareFetch).mockResolvedValueOnce(response(catalog()));
    await discoverWorkBuddyModels(saved);
    expect(proxyAwareFetch).toHaveBeenCalledTimes(1);
    const [url, options, proxy] = proxyAwareFetch.mock.calls[0];
    expect(url).toBe(`${sites[0][1]}/v3/config`);
    expect(proxy).toBeNull();
    expectNoSecrets(options, [saved.refreshToken, "foreign-secret", "foreign-user", "evil.example"]);
  });

  it("returns sanitized HTTP errors without parsing a potentially secret response body or failing over", async () => {
    const upstream = response({ accessToken: "must-not-leak", message: "private-message" }, 403);
    vi.mocked(proxyAwareFetch).mockResolvedValueOnce(upstream);
    expect(await discoverWorkBuddyModels(credentials())).toEqual({ error: "WorkBuddy model discovery returned HTTP 403", status: 403 });
    expect(upstream.json).not.toHaveBeenCalled();
    expect(proxyAwareFetch).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed discovery catalogs rather than substituting a static or cross-origin listing", async () => {
    vi.mocked(proxyAwareFetch).mockResolvedValueOnce(response({ code: 11128, data: { models: [{ id: "must-not-appear" }] } }));
    await expect(discoverWorkBuddyModels(credentials())).rejects.toThrow("Invalid WorkBuddy account catalog");
    expect(proxyAwareFetch).toHaveBeenCalledTimes(1);
  });
});
