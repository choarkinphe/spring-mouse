import { describe, expect, it, vi } from "vitest";
import registry from "../../open-sse/providers/registry/index.js";
import { PROVIDER_OAUTH, PROVIDERS } from "../../open-sse/providers/index.js";
import { resolveProviderAlias } from "../../open-sse/services/model.js";
import { getExecutor } from "../../open-sse/executors/index.js";
import { OAUTH_PROVIDERS, supportsLiveModelSync } from "../../src/shared/constants/providers.js";

vi.mock("../../src/lib/db/repos/connectionsRepo.js", () => ({ updateProviderConnection: vi.fn() }));

const rows = [
  ["workbuddy", "cbcn", "wb", "https://copilot.tencent.com"],
  ["workbuddy-ai", "cbai", "wbai", "https://www.workbuddy.ai"],
];

describe("WorkBuddy replaces the CodeBuddy channels", () => {
  it.each(rows)("registers %s as the selectable channel on the old alias", (provider, legacyAlias, shortAlias, origin) => {
    const entry = registry.find((item) => item.id === provider);
    expect(entry).toMatchObject({ category: "oauth", authModes: ["oauth"], modelListSource: "upstream" });
    expect(entry.display.name).toMatch(/WorkBuddy/);
    expect(entry.models.length).toBeGreaterThan(0);
    expect(PROVIDERS[provider]).toMatchObject({ baseUrl: `${origin}/v2/chat/completions`, forceStream: true });
    expect(PROVIDER_OAUTH[provider]).toMatchObject({ origin, platform: provider, productId: provider });
    // Both the legacy and the short alias resolve to the replacement channel.
    expect(resolveProviderAlias(legacyAlias)).toBe(provider);
    expect(resolveProviderAlias(shortAlias)).toBe(provider);
    expect(OAUTH_PROVIDERS[provider]).toMatchObject({ id: provider, hasOAuth: true });
    expect(supportsLiveModelSync(provider)).toBe(true);
    expect(getExecutor(provider).provider).toBe(provider);
  });

  it("hides the old CodeBuddy entries from the picker but keeps them runnable", () => {
    for (const id of ["codebuddy-cn", "codebuddy-intl"]) {
      const entry = registry.find((item) => item.id === id);
      expect(entry?.hidden).toBe(true);
      // Still registered so migrated accounts that kept CodeBuddy credentials can
      // execute and refresh without a re-login.
      expect(PROVIDERS[id]).toBeTruthy();
      expect(PROVIDER_OAUTH[id]).toBeTruthy();
      expect(getExecutor(id).provider).toBe(id);
    }
    // The intl legacy entry keeps its own origin and platform.
    expect(PROVIDERS["codebuddy-intl"].baseUrl).toBe("https://www.codebuddy.ai/v2/chat/completions");
    expect(PROVIDER_OAUTH["codebuddy-intl"].platform).toBe("ide");
    // Resolving the legacy ids must not be redirected to the new channels.
    expect(resolveProviderAlias("codebuddy-cn")).toBe("codebuddy-cn");
    expect(resolveProviderAlias("codebuddy-intl")).toBe("codebuddy-intl");
  });
});
