import { describe, expect, it, vi } from "vitest";
import { calculateCostFromTokens, getPricingForModel } from "../../open-sse/providers/pricing.js";
import { buildPricingFromCatalog, toCompactPricing } from "../../src/shared/utils/pricingSync.js";

vi.mock("../../src/lib/db/helpers/kvStore.js", () => ({
  makeKv: () => ({ getAll: async () => ({ opencode: { "glm-5.3-flash-free": { input: 2, output: 3 } } }) }),
}));
vi.mock("../../src/lib/db/driver.js", () => ({ getAdapter: vi.fn(() => { throw new Error("Unexpected database access"); }) }));
vi.mock("@/lib/redis/hotCache.js", () => ({ deleteHotJson: vi.fn() }));

const FREE_PRICE = { input: 0, output: 0, cached: 0, reasoning: 0, cache_creation: 0 };
const FREE_MODELS = ["deepseek-v4.1-flash-free", "glm-5.3-flash-free", "big-pickle", "mimo-v2.6-flash-free", "future-model-free"];

describe("OpenCode Free pricing", () => {
  it.each(["opencode", "oc"])("uses zero rates only for %s free directory models", (provider) => {
    for (const model of FREE_MODELS) {
      const price = getPricingForModel(provider, model);
      expect(price).toEqual(FREE_PRICE);
      expect(toCompactPricing(price)).toEqual({ input: 0, output: 0 });
      expect(calculateCostFromTokens({ prompt_tokens: 1_000_000, completion_tokens: 1_000_000 }, price)).toBe(0);
    }
  });

  it("keeps paid models, other providers and unknown prices unchanged", () => {
    for (const provider of ["opencode-go", "deepseek", undefined]) {
      expect(getPricingForModel(provider, "deepseek-v4.1-flash-free")).toMatchObject({ input: 0.14, output: 0.28 });
      expect(getPricingForModel(provider, "glm-5.3-flash-free")).toMatchObject({ input: 1, output: 4 });
      expect(getPricingForModel(provider, "future-model-free")).toBeNull();
    }
    expect(getPricingForModel("opencode", "deepseek-v4.1-flash")).toMatchObject({ input: 0.14, output: 0.28 });
    expect(getPricingForModel("opencode", "glm-5.3-flash")).toMatchObject({ input: 1, output: 4 });
    expect(getPricingForModel("opencode", "unknown-model")).toBeNull();
  });

  it("does not replace free defaults with paid catalog rates during sync", async () => {
    const catalog = { opencode: { models: Object.fromEntries(FREE_MODELS.map((id) => [id, { cost: { input: 9, output: 18 } }])) } };
    const { pricing, stats } = await buildPricingFromCatalog(catalog, FREE_MODELS.map((model) => ({ provider: "oc", model })));
    expect(pricing).toEqual({});
    expect(stats).toMatchObject({ scanned: FREE_MODELS.length, added: 0, fixed: 0, skippedExisting: FREE_MODELS.length, unresolved: 0 });
  });

  it("preserves explicit user overrides in single and batch repository lookups", async () => {
    const repo = await import("../../src/lib/db/repos/pricingRepo.js");
    expect(await repo.getPricingForModel("opencode", "glm-5.3-flash-free")).toEqual({ input: 2, output: 3 });
    expect(await repo.getPricingForModel("opencode", "deepseek-v4.1-flash-free")).toEqual(FREE_PRICE);
    const batch = await repo.getPricingForModels(FREE_MODELS.map((model) => ({ provider: "opencode", model })));
    expect(batch.get("opencode/glm-5.3-flash-free")).toEqual({ input: 2, output: 3 });
    expect(batch.get("opencode/big-pickle")).toEqual(FREE_PRICE);
    const sync = await buildPricingFromCatalog({}, [{ provider: "opencode", model: "glm-5.3-flash-free" }], { resolveCurrent: repo.getPricingForModel });
    expect(sync.pricing).toEqual({});
    expect(sync.stats.skippedExisting).toBe(1);
  });
});
