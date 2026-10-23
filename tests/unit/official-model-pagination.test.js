import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Service-level tests: all requests are intercepted. Never use real accounts,
// provider endpoints, OAuth refresh, or the user's persistent database.
let discoverConnectionModels;
let fetchMock;
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
    updateProviderCredentials: vi.fn(() => { throw new Error("Unexpected credential persistence"); }),
  }));
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  ({ discoverConnectionModels } = await import("@/lib/services/officialModelDiscovery.js"));
});

beforeEach(() => {
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
