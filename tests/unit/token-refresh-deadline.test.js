import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
let originalFetch, providers, dedup;
beforeEach(async () => {
  vi.useFakeTimers(); vi.resetModules();
  originalFetch = globalThis.fetch;
  globalThis.fetch = vi.fn();
  // The provider uses both global fetch and explicit proxyAwareFetch.
  vi.doMock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: (...args) => globalThis.fetch(...args) }));
  providers = await import("../../open-sse/services/tokenRefresh/providers.js");
  dedup = await import("../../open-sse/services/tokenRefresh/dedup.js");
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); globalThis.fetch = originalFetch; });
const hang = (signal) => new Promise((_, reject) => {
  signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
});
describe("refresh transport deadline", () => {
  it("aborts a headers stall and permits a subsequent refresh", async () => {
    let signal;
    globalThis.fetch.mockImplementationOnce((_url, init) => { signal = init.signal; return hang(signal); });
    const pending = providers.refreshCodexToken("old");
    await vi.advanceTimersByTimeAsync(60_001);
    expect(signal?.aborted).toBe(true);
    expect(await pending).toBeNull();
    expect(dedup.__test__.cacheSize()).toBe(0);
    globalThis.fetch.mockResolvedValueOnce(Response.json({ access_token: "new", refresh_token: "rotated" }));
    expect((await providers.refreshCodexToken("old")).refreshToken).toBe("rotated");
  });
  it("keeps the deadline until response body parsing is complete", async () => {
    let signal;
    globalThis.fetch.mockImplementationOnce(async (_url, init) => {
      signal = init.signal;
      return { ok: true, json: () => hang(signal) };
    });
    const pending = providers.refreshClaudeOAuthToken("old-claude");
    await vi.advanceTimersByTimeAsync(60_001);
    expect(signal?.aborted).toBe(true);
    expect(await pending).toBeNull();
    expect(dedup.__test__.cacheSize()).toBe(0);
  });
  it("does not cache a late result from an operation that ignores cancellation", async () => {
    let finish;
    const pending = dedup.dedupRefresh("bad", "old", () => new Promise(r => { finish = r; }));
    await vi.advanceTimersByTimeAsync(60_001);
    expect(await pending).toBeNull();
    finish({ accessToken: "late" });
    await vi.advanceTimersByTimeAsync(0);
    expect(dedup.__test__.cacheSize()).toBe(0);
  });
  it("releases the outer credential lock after a shared refresh times out", async () => {
    const { refreshProviderCredentials } = await import("../../open-sse/services/oauthCredentialManager.js");
    const credentials = { id: "account", refreshToken: "shared-old" };
    globalThis.fetch.mockImplementationOnce((_url, init) => hang(init.signal));
    const a = refreshProviderCredentials("codex", credentials);
    const b = refreshProviderCredentials("codex", credentials);
    await vi.advanceTimersByTimeAsync(60_001);
    expect(await Promise.all([a, b])).toEqual([null, null]);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    globalThis.fetch.mockResolvedValueOnce(Response.json({ access_token: "recovered" }));
    expect(await refreshProviderCredentials("codex", credentials)).toMatchObject({ accessToken: "recovered" });
  });

  it("cancels xAI discovery without starting a fallback refresh", async () => {
    let discoverySignal;
    globalThis.fetch.mockImplementationOnce((_url, init) => { discoverySignal = init.signal; return hang(init.signal); });
    const pending = providers.refreshXaiToken("xai-old");
    await vi.waitFor(() => expect(discoverySignal).toBeDefined());
    await vi.advanceTimersByTimeAsync(60_001);
    expect(await pending).toBeNull();
    expect(discoverySignal.aborted).toBe(true);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it("bounds Vertex token minting through the real JWT signer", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
    const { refreshVertexToken } = await import("../../open-sse/services/tokenRefresh.js");
    let signal;
    globalThis.fetch.mockImplementationOnce((_url, init) => { signal = init.signal; return hang(signal); });
    const pending = refreshVertexToken({ client_email: "test@example.invalid", private_key: privateKey });
    await vi.waitFor(() => expect(signal).toBeDefined());
    await vi.advanceTimersByTimeAsync(60_001);
    expect(signal.aborted).toBe(true);
    expect(await pending).toBeNull();
    expect(dedup.__test__.cacheSize()).toBe(0);
  });

  it("preserves rotated Kiro tokens when optional profile discovery hangs", async () => {
    let profileSignal;
    globalThis.fetch.mockResolvedValueOnce(Response.json({ accessToken: "new-kiro", refreshToken: "rotated-kiro", expiresIn: 3600 }));
    globalThis.fetch.mockImplementationOnce((_url, init) => { profileSignal = init.signal; return hang(profileSignal); });
    const pending = providers.refreshKiroToken("old-kiro", {});
    await vi.waitFor(() => expect(profileSignal).toBeDefined());
    await vi.advanceTimersByTimeAsync(5_001);
    expect(profileSignal?.aborted).toBe(true);
    expect(await pending).toMatchObject({ accessToken: "new-kiro", refreshToken: "rotated-kiro" });
  });
});
