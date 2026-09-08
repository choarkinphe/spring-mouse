import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { handleChatSearch } from "../../open-sse/handlers/search/chatSearch.js";

const originalFetch = globalThis.fetch;

describe("chat search client cancellation", () => {
  beforeEach(() => {
    globalThis.fetch = vi.fn((_url, { signal }) => new Promise((_, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }));
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("stops reading a provider body when the client disconnects after headers", async () => {
    const client = new AbortController();
    globalThis.fetch = vi.fn(async (_url, { signal }) => ({
      ok: true,
      status: 200,
      json: () => new Promise((_, reject) => {
        if (signal.aborted) reject(signal.reason);
        else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }),
    }));
    const pending = handleChatSearch({
      provider: "openai",
      query: "latest test query",
      model: "gpt-4.1",
      credentials: { apiKey: "test-key" },
      signal: client.signal,
      log: {},
    });
    await vi.waitFor(() => expect(globalThis.fetch).toHaveBeenCalledTimes(1));
    client.abort("client disconnected");

    await expect(pending).resolves.toMatchObject({ success: false, status: 499 });
  });

  it("stops the provider request when the client disconnects", async () => {
    const client = new AbortController();
    const pending = handleChatSearch({
      provider: "openai",
      query: "latest test query",
      model: "gpt-4.1",
      credentials: { apiKey: "test-key" },
      signal: client.signal,
      log: {},
    });

    client.abort("client disconnected");

    await expect(pending).resolves.toMatchObject({ success: false, status: 499 });
  });
});
