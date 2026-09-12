import { describe, expect, it } from "vitest";
import { getProviderCustomModelRows } from "../../src/shared/utils/providerCustomModels.js";

describe("provider custom model rows", () => {
  it("includes legacy aliases stored under the provider id when the UI uses a ui alias", () => {
    const rows = getProviderCustomModelRows({
      providerAlias: "ds",
      providerAliases: ["deepseek"],
      modelAliases: {
        "v4-pro": "deepseek/deepseek-v4-pro",
        "v4-flash": "ds/deepseek-v4-flash",
      },
      builtInModels: [{ id: "deepseek-v4-pro" }],
      type: "llm",
    });

    expect(rows.map((row) => row.id)).toEqual(["deepseek-v4-flash"]);
  });
});
