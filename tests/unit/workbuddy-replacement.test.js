import { afterEach, describe, expect, it, vi } from "vitest";
const fetchMock = vi.hoisted(() => vi.fn());
vi.mock("open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: (...args) => fetchMock(...args) }));
const { getExecutor } = await import("../../open-sse/executors/index.js");
const { buildWorkBuddyHeaders, resolveWorkBuddySite } = await import("../../open-sse/config/workbuddy.js");
const { refreshWorkBuddyToken } = await import("../../open-sse/services/tokenRefresh/workbuddy.js");
const { discoverWorkBuddyModels } = await import("../../open-sse/services/workbuddyModels.js");
const { resolveProviderAlias } = await import("../../open-sse/services/model.js");
const { shouldRefreshCredentials } = await import("../../open-sse/services/oauthCredentialManager.js");

const legacy = (provider) => ({
  provider, authType: "oauth", accessToken: "synthetic-legacy-access", refreshToken: "synthetic-legacy-refresh", expiresAt: "2020-01-01",
  providerSpecificData: {
    workbuddyLegacyCredential: true, codebuddyUid: "synthetic-uid",
    workbuddyEndpointOrigin: provider === "workbuddy" ? "https://copilot.tencent.com" : "https://www.codebuddy.ai",
  },
});
const fresh = provider => ({
  provider, accessToken: "synthetic-fresh-access",
  providerSpecificData: {
    workbuddyLegacyCredential: false, workbuddyProduct: provider, workbuddyPlatform: provider, workbuddyContract: "0.1.30",
    workbuddyOrigin: provider === "workbuddy" ? "https://copilot.tencent.com" : "https://www.workbuddy.ai",
    domain: provider === "workbuddy" ? "copilot.tencent.com" : "www.workbuddy.ai", codebuddyUid: "synthetic-uid", tokenType: "Bearer",
  },
});
afterEach(() => fetchMock.mockReset());

describe.each(["workbuddy", "workbuddy-ai"])("%s no longer silently delegates legacy accounts", provider => {
  it("rejects chat, headers, request transform, refresh and discovery before any network call", async () => {
    const executor = getExecutor(provider), saved = legacy(provider);
    const result = await executor.execute({ model: "test", body: { messages: [] }, stream: true, credentials: saved });
    expect(result.response.status).toBe(409);
    expect(await result.response.text()).toContain("Legacy CodeBuddy credentials");
    expect(() => executor.buildHeaders(saved)).toThrow(/Legacy CodeBuddy/);
    expect(() => executor.transformRequest("test", { messages: [] }, true, saved)).toThrow(/Legacy CodeBuddy/);
    expect(() => executor.buildUrl("test", true, 0, saved)).toThrow(/Legacy CodeBuddy/);
    expect(() => buildWorkBuddyHeaders(provider, saved)).toThrow(/Legacy CodeBuddy/);
    await expect(refreshWorkBuddyToken(provider, saved)).rejects.toThrow(/Legacy CodeBuddy/);
    await expect(discoverWorkBuddyModels(saved)).rejects.toThrow(/Legacy CodeBuddy/);
    expect(shouldRefreshCredentials(provider, saved)).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("preserves origin evidence without treating it as authorization for the new product", () => {
    expect(resolveWorkBuddySite(provider, legacy(provider).providerSpecificData).origin).toBe(
      provider === "workbuddy" ? "https://copilot.tencent.com" : "https://www.codebuddy.ai",
    );
    expect(() => buildWorkBuddyHeaders(provider, legacy(provider))).toThrow();
  });

  it("uses the bound new-product transport only after explicit authorization", () => {
    const saved = fresh(provider), executor = getExecutor(provider);
    expect(executor.buildUrl("test", true, 0, saved)).toBe(`${saved.providerSpecificData.workbuddyOrigin}/v2/chat/completions`);
    expect(executor.buildHeaders(saved)).toMatchObject({ "User-Agent": "Spring-Mouse/WorkBuddy-Gateway", "X-User-Id": "synthetic-uid" });
    const instruction = "You are Claude Code, Anthropic's official CLI for Claude. " + "retain user constraints ".repeat(200);
    expect(executor.transformRequest("test", { messages: [{ role: "system", content: instruction }] }, true, saved).messages[0].content).toBe(instruction);
  });
});

it("keeps old aliases resolving without making old credentials new", () => {
  expect(resolveProviderAlias("cbcn")).toBe("workbuddy");
  expect(resolveProviderAlias("cbai")).toBe("workbuddy-ai");
});
