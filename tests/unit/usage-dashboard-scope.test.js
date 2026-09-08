import { describe, expect, it } from "vitest";
import {
  getUsageDashboardScopeApiKeyIds,
  intersectUsageDashboardScope,
} from "@/shared/utils/usageDashboardScope";

describe("usage dashboard tag scope", () => {
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
