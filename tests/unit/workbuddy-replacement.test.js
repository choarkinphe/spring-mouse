import { describe, expect, it, vi } from "vitest";

vi.mock("../../open-sse/services/tokenRefresh/providers.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, refreshCodebuddyToken: vi.fn(async () => "REFRESHED_CN"), refreshCodebuddyIntlToken: vi.fn(async () => "REFRESHED_INTL") };
});

const { getExecutor } = await import("../../open-sse/executors/index.js");
const { buildWorkBuddyHeaders, resolveWorkBuddySite } = await import("../../open-sse/config/workbuddy.js");
const { refreshWorkBuddyToken } = await import("../../open-sse/services/tokenRefresh/workbuddy.js");
const { supportsCodeBuddyCheckin } = await import("../../src/shared/config/codebuddyCheckin.js");
const { CodeBuddyExecutor } = await import("../../open-sse/executors/codebuddy-cn.js");
const { CodeBuddyIntlExecutor } = await import("../../open-sse/executors/codebuddy-intl.js");
const { resolveProviderAlias } = await import("../../open-sse/services/model.js");

// Exactly what migration 027 writes for an account that existed before the
// upgrade. Production accounts must keep working without a re-login, so these
// rows must resolve to the ORIGINAL CodeBuddy implementation, not the new one.
const migratedCn = {
  provider: "workbuddy",
  authType: "oauth",
  accessToken: "legacy-cn-access",
  refreshToken: "legacy-cn-refresh",
  providerSpecificData: {
    codebuddyUid: "cn-uid",
    workbuddyProduct: "workbuddy",
    workbuddyOrigin: "https://copilot.tencent.com",
    workbuddyPlatform: "workbuddy",
    workbuddyContract: "0.1.30",
    domain: "copilot.tencent.com",
    workbuddyLegacyCredential: true,
    workbuddyLegacyOrigin: "https://copilot.tencent.com",
    workbuddyEndpointOrigin: "https://copilot.tencent.com",
  },
};

const migratedIntl = {
  provider: "workbuddy-ai",
  authType: "oauth",
  accessToken: "legacy-intl-access",
  refreshToken: "legacy-intl-refresh",
  providerSpecificData: {
    workbuddyProduct: "workbuddy-ai",
    workbuddyOrigin: "https://www.workbuddy.ai",
    workbuddyPlatform: "workbuddy-ai",
    workbuddyContract: "0.1.30",
    workbuddyLegacyCredential: true,
    workbuddyLegacyOrigin: "https://www.codebuddy.ai",
    workbuddyEndpointOrigin: "https://www.codebuddy.ai",
  },
};

// What an authorization performed by this build stores (no legacy marker).
const freshAuth = (provider, origin, domain) => ({
  provider,
  authType: "oauth",
  accessToken: "fresh-access",
  providerSpecificData: {
    workbuddyProduct: provider,
    workbuddyOrigin: origin,
    workbuddyPlatform: provider,
    workbuddyContract: "0.1.30",
    domain,
    codebuddyUid: "fresh-uid",
    tokenType: "Bearer",
  },
});

describe("replacing the CodeBuddy channels keeps existing production accounts working", () => {
  it("sends a migrated CN account exactly where the old CodeBuddy executor did", () => {
    const executor = getExecutor("workbuddy");
    const legacyExecutor = new CodeBuddyExecutor();
    const fresh = freshAuth("workbuddy", "https://copilot.tencent.com", "copilot.tencent.com");
    expect(executor.buildUrl("glm-5.2", true, 0, migratedCn)).toBe(legacyExecutor.buildUrl("glm-5.2", true, 0, migratedCn));
    // Same pre-upgrade request transform, including its system-prompt handling.
    expect(executor.transformRequest("glm-5.2", { messages: [{ role: "system", content: "S" }, { role: "user", content: "U" }] }, true, migratedCn))
      .toEqual(legacyExecutor.transformRequest("glm-5.2", { messages: [{ role: "system", content: "S" }, { role: "user", content: "U" }] }, true, migratedCn));
    // A freshly authorized account takes the new WorkBuddy transform instead.
    expect(executor.transformRequest("glm-5.2", { messages: [{ role: "system", content: "S" }, { role: "user", content: "U" }] }, true, fresh))
      .not.toEqual(legacyExecutor.transformRequest("glm-5.2", { messages: [{ role: "system", content: "S" }, { role: "user", content: "U" }] }, true, fresh));
  });

  it("sends a migrated international account to the host that issued its tokens", () => {
    const executor = getExecutor("workbuddy-ai");
    expect(executor.buildUrl("glm-5.2", true, 0, migratedIntl)).toBe(new CodeBuddyIntlExecutor().buildUrl("glm-5.2", true, 0, migratedIntl));
    expect(executor.buildUrl("glm-5.2", true, 0, migratedIntl)).toBe("https://www.codebuddy.ai/v2/chat/completions");
    // Credentials issued by one product are never sent to another product's host.
    expect(resolveWorkBuddySite("workbuddy-ai", migratedIntl.providerSpecificData).origin).toBe("https://www.codebuddy.ai");
  });

  it("refreshes migrated accounts with their original refresh implementation", async () => {
    const providers = await import("../../open-sse/services/tokenRefresh/providers.js");
    await expect(refreshWorkBuddyToken("workbuddy", migratedCn, null)).resolves.toBe("REFRESHED_CN");
    await expect(refreshWorkBuddyToken("workbuddy-ai", migratedIntl, null)).resolves.toBe("REFRESHED_INTL");
    expect(providers.refreshCodebuddyToken).toHaveBeenCalledWith("legacy-cn-refresh", null);
    expect(providers.refreshCodebuddyIntlToken).toHaveBeenCalledWith("legacy-intl-refresh", null);
  });

  it("keeps a migrated CN account eligible for daily check-in, and keeps international out", () => {
    expect(supportsCodeBuddyCheckin(migratedCn)).toBe(true);
    expect(supportsCodeBuddyCheckin(migratedIntl)).toBe(false);
  });

  it("uses the new WorkBuddy path only for credentials this build authorized", () => {
    const executor = getExecutor("workbuddy-ai");
    const fresh = freshAuth("workbuddy-ai", "https://www.workbuddy.ai", "www.workbuddy.ai");
    expect(executor.buildUrl("glm-5.2", true, 0, fresh)).toBe("https://www.workbuddy.ai/v2/chat/completions");
    const headers = buildWorkBuddyHeaders("workbuddy-ai", fresh, { stream: true });
    expect(headers["X-Domain"]).toBe("www.workbuddy.ai");
    expect(headers["X-User-Id"]).toBe("fresh-uid");
  });

  it("does not let a legacy row smuggle credentials to a different legacy origin", () => {
    const tampered = {
      ...migratedIntl,
      providerSpecificData: { ...migratedIntl.providerSpecificData, workbuddyEndpointOrigin: "https://evil.example" },
    };
    expect(() => resolveWorkBuddySite("workbuddy-ai", tampered.providerSpecificData)).toThrow(/origin mismatch/);
    expect(() => buildWorkBuddyHeaders("workbuddy-ai", tampered)).toThrow(/origin mismatch/);
  });

  it("keeps the old model prefixes and aliases resolving to the new channels", () => {
    expect(resolveProviderAlias("cbcn")).toBe("workbuddy");
    expect(resolveProviderAlias("cbai")).toBe("workbuddy-ai");
    // Legacy ids remain resolvable for stored rows and older overlays.
    expect(resolveProviderAlias("codebuddy-cn")).toBe("codebuddy-cn");
    expect(resolveProviderAlias("codebuddy-intl")).toBe("codebuddy-intl");
  });
});
