import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/sse/services/auth.js", () => ({
  getProviderCredentials: vi.fn(), markAccountUnavailable: vi.fn(), clearAccountError: vi.fn(),
  resolveApiKeyAccessTags: vi.fn(), authorizeApiKey: vi.fn(),
}));
vi.mock("../../src/sse/services/tokenRefresh.js", () => ({ checkAndRefreshToken: vi.fn() }));
vi.mock("../../src/sse/utils/logger.js", () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }));

import deepseek from "../../open-sse/providers/registry/deepseek.js";
import { AI_PROVIDERS } from "../../src/shared/constants/providers.js";
import { PROVIDER_MEDIA, PROVIDERS } from "../../open-sse/providers/index.js";
import { buildSearchRequest } from "../../open-sse/handlers/search/callers.js";
import { normalizeSearchResponse } from "../../open-sse/handlers/search/normalizers.js";
import { handleSearchCore } from "../../open-sse/handlers/search/index.js";
import { runGatewaySearch, executeGatewaySearchResponse } from "../../src/sse/services/gatewaySearch.js";
import { getProviderCredentials, markAccountUnavailable, clearAccountError, resolveApiKeyAccessTags, authorizeApiKey } from "../../src/sse/services/auth.js";
import { checkAndRefreshToken } from "../../src/sse/services/tokenRefresh.js";

const item = {
  title: "Example", url: "https://example.com/page", snippet: "Short excerpt", summary: "Long summary",
  content: "Page body", rerank_score: 2.4, date: "2026-06-01T00:00:00+00:00",
  site_name: "Example site", site_icon: "https://example.com/icon.ico", authority: 3,
};
const args = { provider: "deepseek", query: "search query", maxResults: 5, apiKey: "gateway-key" };
const account = { connectionId: "account-1", apiKey: "upstream-secret", connectionName: "one" };

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ results: [item] })));
  getProviderCredentials.mockResolvedValue(account);
  resolveApiKeyAccessTags.mockResolvedValue(["team"]);
  checkAndRefreshToken.mockImplementation(async (_provider, credentials) => credentials);
  markAccountUnavailable.mockResolvedValue({ shouldFallback: true });
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("DeepSeek dedicated search", () => {
  it("maps dedicated search through both public builders and retains LLM transport/models", () => {
    expect(AI_PROVIDERS.deepseek.searchConfig).toEqual(deepseek.searchConfig);
    expect(AI_PROVIDERS.deepseek.serviceKinds).toEqual(["llm", "webSearch"]);
    expect(PROVIDER_MEDIA.deepseek.searchConfig).toEqual(deepseek.searchConfig);
    expect(PROVIDERS.deepseek.baseUrl).toContain("chat/completions");
    expect(deepseek.models.length).toBeGreaterThan(0);
  });

  it("builds only documented fields, caps count, and does not accept endpoint/key overrides", () => {
    const request = buildSearchRequest({ id: deepseek.id, ...deepseek.searchConfig }, {
      query: " hello ", maxResults: 100, token: "upstream-secret", contentOptions: { full_page: true },
      providerOptions: { baseUrl: "https://evil.example", apiKey: "other", need_content: false },
    });
    expect(request.url).toBe("https://api.deepseek.com/v1/tools/search");
    expect(request.init.headers.Authorization).toBe("Bearer upstream-secret");
    expect(JSON.parse(request.init.body)).toEqual({ query: "hello", count: 50, need_content: true });
  });

  it("counts Unicode code points and rejects invalid queries/counts", () => {
    const config = { id: deepseek.id, ...deepseek.searchConfig };
    expect(() => buildSearchRequest(config, { query: "😀".repeat(128), maxResults: 5 })).not.toThrow();
    for (const query of [" ", "😀".repeat(129)]) {
      expect(() => buildSearchRequest(config, { query, maxResults: 5 })).toThrow();
    }
    expect(() => buildSearchRequest(config, { query: "hello", maxResults: 1.5 })).toThrow();
  });

  it("normalizes the official results schema including content and ranking metadata", () => {
    const { results, totalResults } = normalizeSearchResponse("deepseek", { results: [item] });
    expect(totalResults).toBe(1);
    expect(results[0]).toMatchObject({ title: item.title, url: item.url, snippet: item.snippet,
      published_at: item.date, favicon_url: item.site_icon, content: { text: item.content, format: "text" },
      metadata: { summary: item.summary, authority: 3, site_name: item.site_name },
      citation: { provider: "deepseek", rank: 1 }, provider_raw: null });
    expect(results[0].score).toBeCloseTo(0.8);
    expect(normalizeSearchResponse("deepseek", { results: [] }).results).toEqual([]);
    expect(() => normalizeSearchResponse("deepseek", {})).toThrow();
  });

  it("uses the dedicated core and default count/content options", async () => {
    const result = await handleSearchCore({ body: { query: "hello" }, provider: AI_PROVIDERS.deepseek,
      providerConfig: deepseek.searchConfig, credentials: account });
    expect(result.success).toBe(true);
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ query: "hello", count: 10, need_content: false });
  });
});

describe("shared internal gateway search", () => {
  it("reuses account credentials/tags without reserving slots, authorizing or metering ingress", async () => {
    const data = await runGatewaySearch(args);
    expect(data).toMatchObject({ provider: "deepseek", query: args.query, results: [{ url: item.url }] });
    expect(getProviderCredentials).toHaveBeenCalledWith("deepseek", expect.any(Set), null,
      expect.objectContaining({ accessTags: ["team"], requesterId: "gateway-key", reserveSlot: false, deadlineMs: expect.any(Number) }));
    expect(authorizeApiKey).not.toHaveBeenCalled();
    expect(fetch.mock.calls[0][1].headers.Authorization).toBe("Bearer upstream-secret");
    expect(clearAccountError).toHaveBeenCalledWith(account.connectionId, account);
  });

  it("uses explicit caller tags and enforces account permission denial", async () => {
    getProviderCredentials.mockResolvedValue({ accessDenied: true });
    await expect(runGatewaySearch({ ...args, accessTags: ["restricted"] })).rejects.toMatchObject({ status: 403 });
    expect(resolveApiKeyAccessTags).not.toHaveBeenCalled();
    expect(getProviderCredentials.mock.calls[0][3].accessTags).toEqual(["restricted"]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects chat-only providers, unknown providers and invalid input without upstream calls", async () => {
    for (const input of [{ provider: "perplexity" }, { provider: "unknown" }, { query: " " }, { maxResults: 0 }]) {
      await expect(runGatewaySearch({ ...args, ...input })).rejects.toMatchObject({ status: 400 });
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refreshes each account and falls back after an upstream error", async () => {
    getProviderCredentials.mockResolvedValueOnce(account).mockResolvedValueOnce({ ...account, connectionId: "two", apiKey: "second" });
    fetch.mockResolvedValueOnce(new Response("secret error body", { status: 500 }));
    expect((await runGatewaySearch(args)).results).toHaveLength(1);
    expect(checkAndRefreshToken).toHaveBeenCalledTimes(2);
    expect(getProviderCredentials.mock.calls[1][1].has("account-1")).toBe(true);
    expect(markAccountUnavailable).toHaveBeenCalledWith("account-1", 500, "Search upstream failed (500)", "deepseek");
  });

  it("bounds fallback calls and sanitizes thrown errors", async () => {
    fetch.mockImplementation(async () => new Response("upstream-secret gateway-key internal URL", { status: 500 }));
    await expect(runGatewaySearch(args)).rejects.toMatchObject({ status: 500, message: "Gateway search failed" });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("honors expired deadlines and pre-aborted signals without credential/upstream calls", async () => {
    const controller = new AbortController(); controller.abort("upstream-secret");
    await expect(runGatewaySearch({ ...args, signal: controller.signal })).rejects.toMatchObject({ status: 499, message: "Search cancelled" });
    await expect(runGatewaySearch({ ...args, deadlineMs: Date.now() - 1 })).rejects.toMatchObject({ status: 504 });
    expect(getProviderCredentials).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("aborts in-flight fetch and does not poison account health or retry", async () => {
    const controller = new AbortController();
    fetch.mockImplementation((_url, { signal }) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })));
    const pending = runGatewaySearch({ ...args, signal: controller.signal });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    controller.abort("secret reason");
    await expect(pending).rejects.toMatchObject({ status: 499, message: "Search cancelled" });
    expect(fetch.mock.calls[0][1].signal.aborted).toBe(true);
    expect(markAccountUnavailable).not.toHaveBeenCalled();
  });

  it("deadline aborts even a stalled body and prevents further accounts", async () => {
    fetch.mockImplementation(async () => ({ ok: true, json: () => new Promise(() => {}) }));
    await expect(runGatewaySearch({ ...args, deadlineMs: Date.now() + 30 })).rejects.toMatchObject({ status: 504 });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][1].signal.aborted).toBe(true);
    expect(markAccountUnavailable).not.toHaveBeenCalled();
  });

  it("public wrapper keeps Response shape and arbitrary supported content options", async () => {
    const response = await executeGatewaySearchResponse({ query: args.query, content_options: { full_page: true } }, "ds", { apiKey: args.apiKey });
    expect(response.ok).toBe(true);
    expect((await response.json()).provider).toBe("deepseek");
    expect(JSON.parse(fetch.mock.calls[0][1].body).need_content).toBe(true);
  });
});
