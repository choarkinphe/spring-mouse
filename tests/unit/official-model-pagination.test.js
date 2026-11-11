import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Service-level tests: all requests are intercepted. Never use real accounts,
// provider endpoints, OAuth refresh, or the user's persistent database.
let discoverConnectionModels;
let fetchMock;
const refreshClaudeOAuthToken = vi.fn();
const updateProviderCredentials = vi.fn();
const API_KEY = "test-only-official-directory-key";
const jsonResponse = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { "Content-Type": "application/json" },
});
const connection = (provider) => ({ id: "isolated-directory-connection", provider, apiKey: API_KEY });
const falPage = (ids, nextCursor = null) => ({
  models: ids.map((id) => ({ endpoint_id: id, metadata: { display_name: `Display ${id}` } })),
  has_more: nextCursor !== null,
  next_cursor: nextCursor,
});
const requestedUrls = () => fetchMock.mock.calls.map(([url]) => new URL(url));
const expectNoPartialSuccess = (result) => {
  expect(result.status).toBeGreaterThanOrEqual(400);
  expect(result.models).toBeUndefined();
  expect(result.discovery?.status).not.toBe("success");
};

beforeAll(async () => {
  vi.resetModules();
  vi.doMock("@/sse/services/tokenRefresh", () => ({
    refreshGoogleToken: vi.fn(() => { throw new Error("Unexpected OAuth refresh"); }),
    refreshCodexToken: vi.fn(() => { throw new Error("Unexpected OAuth refresh"); }),
    refreshClaudeOAuthToken,
    updateProviderCredentials,
  }));
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  ({ discoverConnectionModels } = await import("@/lib/services/officialModelDiscovery.js"));
});

beforeEach(() => {
  refreshClaudeOAuthToken.mockReset().mockResolvedValue(null);
  updateProviderCredentials.mockReset().mockResolvedValue(true);
  fetchMock.mockReset().mockRejectedValue(new Error("Unexpected external request in directory pagination test"));
});

afterAll(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("complete official directory pagination", () => {
  it("combines two fal cursor pages, encodes opaque cursors, and deduplicates boundary models", async () => {
    const cursor = "opaque+/= cursor&not=a-query";
    fetchMock.mockImplementation(async (url) => {
      const parsed = new URL(url);
      expect(parsed.origin + parsed.pathname).toBe("https://api.fal.ai/v1/models");
      if (!parsed.searchParams.has("cursor")) return jsonResponse(falPage(["fal-ai/first", "fal-ai/shared"], cursor));
      expect(parsed.searchParams.get("cursor")).toBe(cursor);
      return jsonResponse(falPage(["fal-ai/shared", "fal-ai/second"]));
    });
    const result = await discoverConnectionModels(connection("fal-ai"));
    expect(result).toMatchObject({
      provider: "fal-ai", listingScope: "public",
      discovery: { status: "success", source: "official", scope: "public", count: 3 },
    });
    expect(result.models.map((model) => model.id)).toEqual(["fal-ai/first", "fal-ai/shared", "fal-ai/second"]);
    expect(result.models[0].name).toBe("Display fal-ai/first");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [, options] of fetchMock.mock.calls) {
      const headers = new Headers(options.headers);
      expect(headers.has("Authorization")).toBe(false);
      expect(headers.has("x-api-key")).toBe(false);
      expect(options.cache).toBe("no-store");
      expect(options.signal).toBeInstanceOf(AbortSignal);
    }
    expect(JSON.stringify(fetchMock.mock.calls)).not.toContain(API_KEY);
  });

  it("follows Gemini nextPageToken using pageToken while retaining query-key authentication", async () => {
    const token = "gemini+/=& token";
    fetchMock.mockResolvedValueOnce(jsonResponse({
      models: [{ name: "models/gemini-first", displayName: "First Gemini" }], nextPageToken: token,
    })).mockResolvedValueOnce(jsonResponse({ models: [{ name: "models/gemini-second" }] }));
    const result = await discoverConnectionModels(connection("gemini"));
    expect(result.discovery).toMatchObject({ status: "success", source: "official", scope: "account", count: 2 });
    expect(result.models.map((model) => model.id)).toEqual(["models/gemini-first", "models/gemini-second"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const urls = requestedUrls();
    expect(urls[0].searchParams.has("pageToken")).toBe(false);
    expect(urls[1].searchParams.get("pageToken")).toBe(token);
    expect(urls[1].searchParams.has("page_token")).toBe(false);
    for (const url of urls) {
      expect(url.origin + url.pathname).toBe("https://generativelanguage.googleapis.com/v1beta/models");
      expect(url.searchParams.get("key")).toBe(API_KEY);
    }
  });

  it.each(["anthropic", "claude"])("follows %s has_more with last_id as after_id", async (provider) => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      data: [{ id: "claude-first" }], has_more: true, last_id: "claude-first",
    })).mockResolvedValueOnce(jsonResponse({ data: [{ id: "claude-second" }], has_more: false }));
    const result = await discoverConnectionModels(connection(provider));
    expect(result.discovery).toMatchObject({ status: "success", count: 2 });
    expect(result.models.map((model) => model.id)).toEqual(["claude-first", "claude-second"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(requestedUrls()[1].searchParams.get("after_id")).toBe("claude-first");
    for (const [url, options] of fetchMock.mock.calls) {
      expect(new URL(url).origin + new URL(url).pathname).toBe("https://api.anthropic.com/v1/models");
      expect(new Headers(options.headers).get("x-api-key")).toBe(API_KEY);
      expect(new Headers(options.headers).get("anthropic-version")).toBe("2023-06-01");
    }
  });

  it("follows Cohere next_page_token as page_token and uses native model names", async () => {
    const token = "cohere+/=& token";
    fetchMock.mockResolvedValueOnce(jsonResponse({
      models: [{ name: "command-first" }], next_page_token: token,
    })).mockResolvedValueOnce(jsonResponse({ models: [{ name: "command-second" }] }));
    const result = await discoverConnectionModels(connection("cohere"));
    expect(result.discovery).toMatchObject({ status: "success", count: 2 });
    expect(result.models.map((model) => model.id)).toEqual(["command-first", "command-second"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(requestedUrls()[1].searchParams.get("page_token")).toBe(token);
    expect(requestedUrls()[1].searchParams.has("pageToken")).toBe(false);
    for (const [url, options] of fetchMock.mock.calls) {
      expect(new URL(url).origin + new URL(url).pathname).toBe("https://api.cohere.ai/v1/models");
      expect(new Headers(options.headers).get("Authorization")).toBe(`Bearer ${API_KEY}`);
    }
  });
});

describe("Claude model discovery authentication", () => {
  const oauthConnection = (extra = {}) => ({
    id: "isolated-claude-oauth", provider: "claude", authType: "oauth",
    accessToken: "test-only-oauth-token", refreshToken: "test-only-refresh-token", ...extra,
  });
  const modelsPage = (id, more = false) => jsonResponse({
    data: [{ id, display_name: `Display ${id}` }], has_more: more, last_id: id,
  });
  const expectOAuthHeaders = (options, token) => {
    const headers = new Headers(options.headers);
    expect(headers.get("Authorization")).toBe(`Bearer ${token}`);
    expect(headers.get("anthropic-beta")).toContain("oauth-2025-04-20");
    expect(headers.get("anthropic-version")).toBe("2023-06-01");
    expect(headers.has("x-api-key")).toBe(false);
  };

  it.each(["oauth", undefined])("uses OAuth headers on every page for authType=%s", async (authType) => {
    fetchMock.mockResolvedValueOnce(modelsPage("first", true)).mockResolvedValueOnce(modelsPage("second"));
    const result = await discoverConnectionModels(oauthConnection({ authType, apiKey: API_KEY,
      providerSpecificData: { copilotToken: "unrelated-token" } }));
    expect(result.models.map(({ id }) => id)).toEqual(["first", "second"]);
    expect(result.discovery).toMatchObject({ status: "success", source: "official", count: 2 });
    expect(requestedUrls()[1].searchParams.get("after_id")).toBe("first");
    for (const [, options] of fetchMock.mock.calls) expectOAuthHeaders(options, "test-only-oauth-token");
    expect(refreshClaudeOAuthToken).not.toHaveBeenCalled();
  });

  it.each(["apikey", "api_key"])("keeps %s authentication separate even with a stale accessToken", async (authType) => {
    fetchMock.mockResolvedValueOnce(modelsPage("key-model"));
    const result = await discoverConnectionModels(oauthConnection({ authType, apiKey: API_KEY }));
    expect(result.discovery.status).toBe("success");
    const headers = new Headers(fetchMock.mock.calls[0][1].headers);
    expect(headers.get("x-api-key")).toBe(API_KEY);
    expect(headers.has("Authorization")).toBe(false);
    expect(headers.has("anthropic-beta")).toBe(false);
    expect(refreshClaudeOAuthToken).not.toHaveBeenCalled();
  });

  it.each([401, 403])("refreshes once after HTTP %s and persists rotating credentials before retry", async (status) => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}, status)).mockResolvedValueOnce(modelsPage("refreshed"));
    refreshClaudeOAuthToken.mockResolvedValue({ accessToken: "new-token", refreshToken: "new-refresh", expiresIn: 3600 });
    const result = await discoverConnectionModels(oauthConnection());
    expect(result.discovery.status).toBe("success");
    expect(refreshClaudeOAuthToken).toHaveBeenCalledExactlyOnceWith("test-only-refresh-token");
    expect(updateProviderCredentials).toHaveBeenCalledExactlyOnceWith("isolated-claude-oauth", expect.objectContaining({
      accessToken: "new-token", refreshToken: "new-refresh", expiresIn: 3600,
    }));
    expect(updateProviderCredentials.mock.invocationCallOrder[0]).toBeLessThan(fetchMock.mock.invocationCallOrder[1]);
    expectOAuthHeaders(fetchMock.mock.calls[0][1], "test-only-oauth-token");
    expectOAuthHeaders(fetchMock.mock.calls[1][1], "new-token");
    expect(fetchMock.mock.calls[1][1].signal).not.toBe(fetchMock.mock.calls[0][1].signal);
  });

  it("retries the failed second page and carries the new token to later pages", async () => {
    fetchMock.mockResolvedValueOnce(modelsPage("first", true)).mockResolvedValueOnce(jsonResponse({}, 401))
      .mockResolvedValueOnce(modelsPage("second", true)).mockResolvedValueOnce(modelsPage("third"));
    refreshClaudeOAuthToken.mockResolvedValue({ accessToken: "new-token", expiresIn: 3600 });
    const result = await discoverConnectionModels(oauthConnection());
    expect(result.models.map(({ id }) => id)).toEqual(["first", "second", "third"]);
    expect(requestedUrls().map(url => url.searchParams.get("after_id"))).toEqual([null, "first", "first", "second"]);
    for (const [, options] of fetchMock.mock.calls.slice(2)) expectOAuthHeaders(options, "new-token");
    expect(updateProviderCredentials).toHaveBeenCalledWith("isolated-claude-oauth", expect.objectContaining({ refreshToken: "test-only-refresh-token" }));
    expect(refreshClaudeOAuthToken).toHaveBeenCalledTimes(1);
  });

  it("does not refresh again when a later page rejects the refreshed token", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}, 401)).mockResolvedValueOnce(modelsPage("first", true))
      .mockResolvedValueOnce(jsonResponse({}, 401));
    refreshClaudeOAuthToken.mockResolvedValue({ accessToken: "new-token" });
    const result = await discoverConnectionModels(oauthConnection());
    expectNoPartialSuccess(result);
    expect(result.status).toBe(401);
    expect(refreshClaudeOAuthToken).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it.each([null, "throw"])("fails safely when refresh returns %s", async (outcome) => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: "private upstream diagnostic" }, 401));
    if (outcome === "throw") refreshClaudeOAuthToken.mockRejectedValue(new Error("private refresh diagnostic"));
    const result = await discoverConnectionModels(oauthConnection());
    expect(result).toEqual({ error: "Failed to fetch models: 401", status: 401 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(updateProviderCredentials).not.toHaveBeenCalled();
  });

  it("does not retry if rotating credentials cannot be saved", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}, 401));
    refreshClaudeOAuthToken.mockResolvedValue({ accessToken: "new-token", refreshToken: "new-refresh" });
    updateProviderCredentials.mockResolvedValue(false);
    const result = await discoverConnectionModels(oauthConnection());
    expectNoPartialSuccess(result);
    expect(result.status).toBe(502);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    { authType: "oauth", accessToken: "", apiKey: API_KEY },
    { authType: "apikey", accessToken: "stale-token", apiKey: "" },
  ])("does not fall back to another credential type when credentials are missing: %j", async (extra) => {
    const result = await discoverConnectionModels(oauthConnection(extra));
    expect(result.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(refreshClaudeOAuthToken).not.toHaveBeenCalled();
  });

  it.each([
    { authType: "oauth", refreshToken: "" },
    { authType: "apikey", apiKey: API_KEY },
  ])("does not refresh missing-refresh-token or API Key connections: %j", async (extra) => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}, 401));
    expect((await discoverConnectionModels(oauthConnection(extra))).status).toBe(401);
    expect(refreshClaudeOAuthToken).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([400, 429, 500])("does not refresh on non-authentication HTTP %s", async (status) => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}, status));
    expect((await discoverConnectionModels(oauthConnection())).status).toBe(status);
    expect(refreshClaudeOAuthToken).not.toHaveBeenCalled();
  });
});

describe("incomplete directory failure boundaries", () => {
  it("rejects a repeated fal cursor without fetching the same page indefinitely", async () => {
    fetchMock.mockImplementation(async () => jsonResponse(falPage(["fal-ai/partial"], "same-cursor")));
    const result = await discoverConnectionModels(connection("fal-ai"));
    expectNoPartialSuccess(result);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(new Set(requestedUrls().map((url) => url.toString())).size).toBe(2);
  });

  it("rejects an unfinished directory after 100 pages rather than admitting partial IDs", async () => {
    fetchMock.mockImplementation(async () => jsonResponse(falPage(
      [`fal-ai/page-${fetchMock.mock.calls.length}`], `cursor-${fetchMock.mock.calls.length}`,
    )));
    const result = await discoverConnectionModels(connection("fal-ai"));
    expectNoPartialSuccess(result);
    expect(result.status).toBe(502);
    expect(result.error).toMatch(/pagination limit/i);
    expect(fetchMock).toHaveBeenCalledTimes(100);
    expect(new Set(requestedUrls().map((url) => url.toString())).size).toBe(100);
  });

  it("accepts a complete terminal page at the 100-page boundary", async () => {
    fetchMock.mockImplementation(async () => {
      const page = fetchMock.mock.calls.length;
      return jsonResponse(falPage([`fal-ai/page-${page}`], page === 100 ? null : `cursor-${page}`));
    });
    const result = await discoverConnectionModels(connection("fal-ai"));
    expect(result.discovery).toMatchObject({ status: "success", source: "official", count: 100 });
    expect(result.models).toHaveLength(100);
    expect(fetchMock).toHaveBeenCalledTimes(100);
  });

  it.each([
    ["HTTP failure", () => new Response("private upstream diagnostic", { status: 503 })],
    ["malformed JSON", () => new Response("<html>private upstream diagnostic</html>")],
    ["malformed page", () => jsonResponse(falPage(["fal-ai/partial"], ""))],
    ["business failure", () => jsonResponse({ ...falPage(["fal-ai/partial"]), error: "private upstream diagnostic" })],
    ["network failure", () => { throw new Error("private upstream diagnostic"); }],
  ])("does not return successful partial fal models after second-page %s", async (_label, secondPage) => {
    fetchMock.mockResolvedValueOnce(jsonResponse(falPage(["fal-ai/page-one"], "page-two")))
      .mockImplementationOnce(async () => secondPage());
    const result = await discoverConnectionModels(connection("fal-ai"));
    expectNoPartialSuccess(result);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(result)).not.toContain("private upstream diagnostic");
  });
});

describe("xAI model discovery errors", () => {
  it.each([402, 403])("explains the spending limit on HTTP %s without echoing upstream diagnostics", async (status) => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      code: "personal-team-blocked:spending-limit",
      error: `You have run out of credits. Private diagnostic: ${API_KEY}`,
    }, status));
    const result = await discoverConnectionModels(connection("xai"));
    expect(result.status).toBe(status);
    expect(result.error).toContain(`HTTP ${status}`);
    expect(result.error).toContain("Grok 额度不足或需要有效订阅");
    expect(result.error).toContain("https://grok.com/?_s=usage");
    expect(JSON.stringify(result)).not.toContain(API_KEY);
    expectNoPartialSuccess(result);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["unknown error", () => jsonResponse({ code: "access-denied", error: API_KEY }, 403)],
    ["HTML error page", () => new Response(`<html>${API_KEY}</html>`, { status: 403 })],
    ["unreadable body", () => ({ ok: false, status: 403, json: async () => { throw new Error(API_KEY); } })],
    ["unrelated status", () => jsonResponse({ code: "personal-team-blocked:spending-limit", error: API_KEY }, 401)],
  ])("keeps the status-only fallback for %s", async (_label, response) => {
    const upstream = response();
    fetchMock.mockResolvedValueOnce(upstream);
    expect(await discoverConnectionModels(connection("xai"))).toEqual({
      error: `Failed to fetch models: ${upstream.status}`, status: upstream.status,
    });
  });

  it("does not classify another provider's error as a Grok spending limit", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ code: "personal-team-blocked:spending-limit" }, 403));
    expect(await discoverConnectionModels(connection("openai"))).toEqual({
      error: "Failed to fetch models: 403", status: 403,
    });
  });
});

describe("media provider discovery authentication", () => {
  it("uses Deepgram Token auth and canonical STT/TTS model IDs", async () => {
    fetchMock.mockResolvedValue(jsonResponse({
      stt: [{ name: "Nova", canonical_name: "nova-3" }],
      tts: [{ name: "zeus", canonical_name: "aura-2-zeus-en" }],
    }));
    const result = await discoverConnectionModels(connection("deepgram"));
    expect(result.discovery).toMatchObject({ status: "success", source: "official", scope: "account", count: 2 });
    expect(result.models.map(({ id, kind }) => ({ id, kind }))).toEqual([
      { id: "nova-3", kind: "stt" }, { id: "aura-2-zeus-en", kind: "tts" },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.deepgram.com/v1/models");
    expect(new Headers(options.headers).get("Authorization")).toBe(`Token ${API_KEY}`);
    expect(JSON.stringify(result)).not.toContain(API_KEY);
  });

  it("uses ElevenLabs xi-api-key rather than Bearer auth or the voices endpoint", async () => {
    fetchMock.mockResolvedValue(jsonResponse([{ model_id: "eleven_multilingual_v2", name: "Multilingual v2" }]));
    const result = await discoverConnectionModels(connection("elevenlabs"));
    expect(result.discovery).toMatchObject({ status: "success", source: "official", scope: "account", count: 1 });
    expect(result.models[0]).toMatchObject({ id: "eleven_multilingual_v2", name: "Multilingual v2" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.elevenlabs.io/v1/models");
    expect(new Headers(options.headers).get("xi-api-key")).toBe(API_KEY);
    expect(new Headers(options.headers).has("Authorization")).toBe(false);
    expect(JSON.stringify(result)).not.toContain(API_KEY);
  });

  it.each(["deepgram", "elevenlabs"])("rejects missing %s credentials before any fetch", async (provider) => {
    const result = await discoverConnectionModels({ ...connection(provider), apiKey: "" });
    expect(result.status).toBe(401);
    expectNoPartialSuccess(result);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
