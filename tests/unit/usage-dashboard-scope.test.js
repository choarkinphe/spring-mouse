import { describe, expect, it } from "vitest";
import { selectUsageDashboardScopeTags } from "@/store/settingsStore";
import { normalizeAccessTags } from "@/shared/utils/accessTags";
import {
  getUsageDashboardScopeApiKeyIds,
  intersectUsageDashboardScope,
} from "@/shared/utils/usageDashboardScope";

describe("usage dashboard tag scope", () => {
  it.each([null, {}, { usageDashboardScopeTags: null }, { usageDashboardScopeTags: [] }])(
    "keeps the external-store snapshot stable with empty settings %j",
    (settings) => {
      const state = { settings };
      const snapshot = selectUsageDashboardScopeTags(state);
      expect(Object.is(selectUsageDashboardScopeTags(state), snapshot)).toBe(true);
      expect(Object.is(selectUsageDashboardScopeTags({ ...state, loading: true }), snapshot)).toBe(true);
      expect(normalizeAccessTags(snapshot)).toEqual([]);
    },
  );

  it("preserves the stored tag reference and reflects a scope change", () => {
    const tags = ["engineering"];
    const state = { settings: { usageDashboardScopeTags: tags } };
    expect(selectUsageDashboardScopeTags(state)).toBe(tags);
    const updated = { settings: { usageDashboardScopeTags: ["sales"] } };
    expect(selectUsageDashboardScopeTags(updated)).not.toBe(tags);
    expect(normalizeAccessTags(selectUsageDashboardScopeTags(updated))).toEqual(["sales"]);
  });

  const apiKeys = [{ id: "alice" }, { id: "bob" }, { id: "carol" }];
  const apiKeyAccessTags = {
    alice: ["engineering", "china"],
    bob: ["sales"],
    carol: ["engineering", "us"],
  };

  it("is unrestricted when no scope tags are configured", () => {
    expect(getUsageDashboardScopeApiKeyIds({ apiKeys, apiKeyAccessTags, scopeTags: [] })).toBeNull();
  });

  it("includes users matching any selected tag", () => {
    expect(getUsageDashboardScopeApiKeyIds({
      apiKeys,
      apiKeyAccessTags,
      scopeTags: ["sales", "engineering"],
    })).toEqual(["alice", "bob", "carol"]);
  });

  it("does not allow an API-key drilldown outside the configured scope", () => {
    const scopedIds = getUsageDashboardScopeApiKeyIds({ apiKeys, apiKeyAccessTags, scopeTags: ["engineering"] });
    expect(intersectUsageDashboardScope(scopedIds, "bob")).toEqual([]);
    expect(intersectUsageDashboardScope(scopedIds, "alice")).toEqual(["alice"]);
  });
});
