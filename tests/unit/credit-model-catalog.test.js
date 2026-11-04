import { describe, it, expect } from "vitest";
import { parseQoderCatalog } from "../../open-sse/services/qoderModels.js";
import { parseWorkBuddyModels } from "../../open-sse/services/workbuddyModels.js";
import { getPricingForModel } from "../../open-sse/providers/pricing.js";
import { modelCreditBilling } from "../../open-sse/config/creditBilling.js";
import { buildPricingFromCatalog } from "../../src/shared/utils/pricingSync.js";
import { getProviderCustomModelRows } from "../../src/shared/utils/providerCustomModels.js";

describe("Qoder account scene catalog", () => {
  it("merges app-first and chat-only records, preserving routing configs and display names", () => {
    const app = { key: "fast", display_name: "Fast", price_factor: 0.8, enable: true };
    const hidden = { key: "hidden", enable: false, price_factor: 8 };
    const result = parseQoderCatalog({ app: [app, hidden, { key: "auto" }], chat: [
      { key: "fast", display_name: "old chat name", price_factor: 9 },
      { key: "performance", display_name: "Performance", price_factor: 1.1 },
      { key: "qfmodel", display_name: "Qwen3.8-Flash", price_factor: 0, original_price_factor: 0.1 },
    ] });
    expect(result.models.map(m => m.id)).toEqual(["fast", "performance", "qfmodel"]);
    expect(result.models[0]).toMatchObject({ name: "Fast", rateMultiplier: 0.8 });
    expect(result.models[2]).toMatchObject({ name: "Qwen3.8-Flash", rateMultiplier: 0, originalRateMultiplier: 0.1, isFree: true });
    expect(result.rawConfigs.get("fast")).toBe(app);
    expect(result.rawConfigs.get("hidden")).toBe(hidden);
    expect(result.rawConfigs.has("auto")).toBe(true);
  });
  it("uses active promotions and refuses missing/malformed rates rather than inventing free or 1x", () => {
    const models = parseQoderCatalog({ chat: [
      { key: "promo", priceFactor: 0, promotion: { active: true, beforePromotionPriceFactor: 2, discountFactor: 0.5 } },
      { key: "notfree", is_free: true, price_factor: 0.5 },
      ...[null, "", -1, "bad", false].map((rate, n) => ({ key: `invalid-${n}`, price_factor: rate })),
    ] }).models;
    expect(models[0]).toMatchObject({ rateMultiplier: 1, originalRateMultiplier: 2, isFree: false });
    expect(models[1]).toMatchObject({ rateMultiplier: 0.5, isFree: false });
    for (const model of models.slice(2)) expect(model.rateMultiplier).toBeUndefined();
  });
  it("accepts app-only catalog and rejects missing directory arrays", () => {
    expect(parseQoderCatalog({ app: [{ key: "qmodel", displayName: "Qwen", priceFactor: "0.5" }] }).models[0]).toMatchObject({ name: "Qwen", rateMultiplier: 0.5 });
    expect(parseQoderCatalog({})).toBeNull();
  });
});

describe("credit billing is not token pricing", () => {
  it.each(["qoder", "qd", "qoder-cn", "qdcn", "workbuddy", "cbcn", "workbuddy-ai", "cbai", "kiro", "kr"])("does not apply token prices to %s", provider => {
    expect(getPricingForModel(provider, "auto")).toBeNull();
    expect(getPricingForModel(provider, "claude-sonnet-4-6")).toBeNull();
    expect(modelCreditBilling(provider, { rateMultiplier: 0, originalRateMultiplier: 0.1 })).toEqual({ unit: "credits", multiplier: 0, originalMultiplier: 0.1 });
    expect(modelCreditBilling(provider)).toEqual({ unit: "credits", multiplier: null });
  });
  it("never imports catalog dollar prices into a credit channel", async () => {
    const result = await buildPricingFromCatalog({ vendor: { models: { "glm-5.3": { cost: { input: 1, output: 2 } } } } }, [{ provider: "workbuddy", model: "glm-5.3" }]);
    expect(result.pricing).toEqual({});
    expect(result.unresolved[0]).toMatchObject({ reason: "credit_billed" });
    expect(getPricingForModel("openai", "gpt-4o")).not.toBeNull();
  });
  it("parses official WorkBuddy credits, including free models, without accepting arbitrary strings", () => {
    const ids = ["a", "b", "c", "d"];
    const parsed = parseWorkBuddyModels({ code: 0, data: { agents: [{ name: "cli", models: ids }], models: ids.map((id, i) => ({ id, name: id.toUpperCase(), credits: ["x0.08", "x0.00", "$2", "xInfinity"][i] })) } });
    expect(parsed[0]).toMatchObject({ name: "A", rateMultiplier: 0.08, isFree: false });
    expect(parsed[1]).toMatchObject({ rateMultiplier: 0, isFree: true });
    expect(parsed[2].rateMultiplier).toBeUndefined();
    expect(parsed[3].rateMultiplier).toBeUndefined();
  });
  it("preserves credit metadata in UI row derivation", () => {
    const [row] = getProviderCustomModelRows({ providerAlias: "qd", customModels: [{ id: "qfmodel", providerAlias: "qd", name: "Qwen3.8-Flash", rateMultiplier: 0, originalRateMultiplier: 0.1 }] });
    expect(row).toMatchObject({ name: "Qwen3.8-Flash", rateMultiplier: 0, originalRateMultiplier: 0.1 });
  });
});
