import { describe, it, expect } from "vitest";
import { buildPricingFromCatalog, collectPricingTargets, toCompactPricing } from "../../src/shared/utils/pricingSync.js";

/**
 * A miniature models.dev payload. Only `cost` / `limit` shapes matter here.
 */
const CATALOG = {
  openai: {
    models: {
      "gpt-6-astra": { id: "gpt-6-astra", cost: { input: 10, output: 50, cache_read: 1, cache_write: 12.5 } },
      "gpt-5.6-sol": { id: "gpt-5.6-sol", cost: { input: 5, output: 30, cache_read: 0.5, cache_write: 6.25 } },
      "gpt-5.6": { id: "gpt-5.6", cost: { input: 2.5, output: 15, cache_read: 0.25, cache_write: 2.5 } },
      // Non-numeric and all-zero entries must be rejected.
      "bad-strings": { id: "bad-strings", cost: { input: "1.0", output: "nope" } },
      "all-zero": { id: "all-zero", cost: { input: 0, output: 0 } },
    },
  },
  deepseek: {
    models: {
      "deepseek-flash": { id: "deepseek-flash", cost: { input: 0.15, output: 0.6, cache_read: 0.003 } },
    },
  },
  moonshotai: {
    models: {
      "kimi-k3": { id: "kimi-k3", cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 } },
    },
  },
  // Same model id under several resellers with divergent prices — the median wins.
  zai: { models: { "glm-5.2": { id: "glm-5.2", cost: { input: 1.4, output: 4.4, cache_read: 0.26 } } } },
  crof: { models: { "glm-5.2": { id: "glm-5.2", cost: { input: 0.3, output: 1.05, cache_read: 0.05 } } } },
  above: { models: { "glm-5.2": { id: "glm-5.2", cost: { input: 1.54, output: 4.84, cache_read: 0.154 } } } },
};

// A resolver standing in for the runtime chain. `known` simulates models the
// static tables (MODEL_PRICING / PATTERN_PRICING) already price correctly.
const makeResolver = (known = {}) => (provider, model) => known[`${provider}/${model}`] || null;

describe("buildPricingFromCatalog", () => {
  it("maps models.dev cost fields onto the local pricing shape", async () => {
    const { pricing } = await buildPricingFromCatalog(CATALOG, [{ provider: "codex", model: "gpt-6-astra" }], {
      resolveCurrent: makeResolver(),
    });

    expect(pricing.codex["gpt-6-astra"]).toEqual({
      input: 10,
      output: 50,
      cached: 1,
      cache_creation: 12.5,
      reasoning: 50,
    });
  });

  it("normalizes an alias provider to its registry id before writing", async () => {
    // "cx" is codex's alias; the written key must be the id that usage rows use.
    const { pricing } = await buildPricingFromCatalog(CATALOG, [{ provider: "cx", model: "gpt-6-astra" }], {
      resolveCurrent: makeResolver(),
    });

    expect(Object.keys(pricing)).toEqual(["codex"]);
    expect(pricing.codex["gpt-6-astra"]).toBeDefined();
  });

  it("NEVER overwrites a model that already resolves to a price", async () => {
    // The critical case: `getPricing()` (used naively) only knows PROVIDER_PRICING,
    // so a static MODEL_PRICING entry like gpt-5.6 looks "missing" and would be
    // rewritten with the catalog price. resolveCurrent must be the runtime chain.
    const resolveCurrent = makeResolver({
      "codex/gpt-5.6": { input: 1.25, output: 10, cached: 0.625 },
    });

    const { pricing, stats } = await buildPricingFromCatalog(
      CATALOG,
      [{ provider: "codex", model: "gpt-5.6" }],
      { resolveCurrent },
    );

    expect(pricing.codex).toBeUndefined();
    expect(stats.skippedExisting).toBe(1);
    expect(stats.added).toBe(0);
  });

  it("skips zero-price and non-numeric catalog entries", async () => {
    const { pricing, stats } = await buildPricingFromCatalog(
      CATALOG,
      [
        { provider: "codex", model: "all-zero" },
        { provider: "codex", model: "bad-strings" },
      ],
      { resolveCurrent: makeResolver() },
    );

    expect(pricing.codex).toBeUndefined();
    expect(stats.skippedNoCost).toBe(2);
    expect(stats.unresolved).toBe(2);
  });

  it("falls back to the global index when the provider mapping has no entry", async () => {
    // codebuddy-intl has no models.dev mapping; the model id exists globally.
    const { pricing } = await buildPricingFromCatalog(
      CATALOG,
      [{ provider: "codebuddy-intl", model: "deepseek-flash" }],
      { resolveCurrent: makeResolver() },
    );

    expect(pricing["codebuddy-intl"]["deepseek-flash"].input).toBe(0.15);
  });

  it("takes the median price when one model id appears under many providers", async () => {
    const { pricing } = await buildPricingFromCatalog(
      CATALOG,
      [{ provider: "glm-cn", model: "glm-5.2" }],
      { resolveCurrent: makeResolver() },
    );

    // inputs 0.3 / 1.4 / 1.54 → median 1.4 (not the first-seen 0.3)
    expect(pricing["glm-cn"]["glm-5.2"].input).toBe(1.4);
  });

  it("corrects a variant that only matched a wildcard, using the base model's authored price", async () => {
    // `gpt-5.6-sol-review` has no MODEL_PRICING entry, so it resolves through
    // the `gpt-5.6-*` glob to 2.5/15. Its base `gpt-5.6-sol` IS authored at
    // 5/30 — the review variant should adopt that.
    const resolveCurrent = makeResolver({
      "codex/gpt-5.6-sol-review": { input: 2.5, output: 15, cached: 0.25, reasoning: 15, cache_creation: 2.5 },
    });

    const { pricing, stats } = await buildPricingFromCatalog(
      CATALOG,
      [{ provider: "codex", model: "gpt-5.6-sol-review" }],
      { resolveCurrent },
    );

    expect(pricing.codex["gpt-5.6-sol-review"].input).toBe(5);
    expect(pricing.codex["gpt-5.6-sol-review"].output).toBe(30);
    expect(stats.fixed).toBe(1);
    expect(stats.added).toBe(0);
  });

  it("leaves a variant alone when it already agrees with its base model", async () => {
    const resolveCurrent = makeResolver({
      "codex/gpt-5.6-sol-review": { input: 5, output: 30, cached: 0.5, reasoning: 30, cache_creation: 5 },
    });

    const { pricing, stats } = await buildPricingFromCatalog(
      CATALOG,
      [{ provider: "codex", model: "gpt-5.6-sol-review" }],
      { resolveCurrent },
    );

    expect(pricing.codex).toBeUndefined();
    expect(stats.fixed).toBe(0);
    expect(stats.skippedExisting).toBe(1);
  });

  it("does NOT strip a suffix off a model that is itself explicitly priced", async () => {
    // `gpt-5.1-codex-max` is a real, separately-priced model (8/32). Treating
    // `-max` as a variant suffix would wrongly repoint it at `gpt-5.1-codex`
    // (1.25/10), which has an authored price in the real MODEL_PRICING table.
    const { pricing, stats } = await buildPricingFromCatalog(
      CATALOG,
      [{ provider: "codex", model: "gpt-5.1-codex-max" }],
      { resolveCurrent: makeResolver({ "codex/gpt-5.1-codex-max": { input: 8, output: 32 } }) },
    );

    expect(pricing.codex).toBeUndefined();
    expect(stats.fixed).toBe(0);
    expect(stats.skippedExisting).toBe(1);
  });

  it("reports models the catalog cannot price instead of guessing", async () => {
    const { pricing, stats, unresolved } = await buildPricingFromCatalog(
      CATALOG,
      [{ provider: "codex", model: "no-such-model" }],
      { resolveCurrent: makeResolver() },
    );

    expect(pricing.codex).toBeUndefined();
    expect(stats.unresolved).toBe(1);
    expect(unresolved[0]).toEqual({ provider: "codex", model: "no-such-model" });
  });
});

describe("collectPricingTargets", () => {
  it("de-duplicates and normalizes both source forms", () => {
    const targets = collectPricingTargets({
      customModels: [{ providerAlias: "cx", id: "gpt-5.6-sol" }],
      usagePairs: [{ provider: "codex", model: "gpt-5.6-sol" }],
    });

    expect(targets).toEqual([{ provider: "codex", model: "gpt-5.6-sol" }]);
  });

  it("restricts to one channel when providerId is given", () => {
    const targets = collectPricingTargets({
      customModels: [
        { providerAlias: "cx", id: "gpt-5.6-sol" },
        { providerAlias: "glm-cn", id: "glm-5.2" },
      ],
      usagePairs: [],
      providerId: "codex",
    });

    expect(targets).toEqual([{ provider: "codex", model: "gpt-5.6-sol" }]);
  });

  it("accepts an alias as providerId", () => {
    const targets = collectPricingTargets({
      customModels: [
        { providerAlias: "cx", id: "gpt-5.6-sol" },
        { providerAlias: "glm-cn", id: "glm-5.2" },
      ],
      usagePairs: [],
      providerId: "cx",
    });

    expect(targets).toEqual([{ provider: "codex", model: "gpt-5.6-sol" }]);
  });

  it("drops rows with no provider (count_tokens, image endpoints)", () => {
    // 843 such rows exist in production. A `null/<model>` price key is junk.
    const targets = collectPricingTargets({
      customModels: [],
      usagePairs: [
        { provider: null, model: "deepseek-flash" },
        { provider: undefined, model: "glm-5.3" },
        { provider: "codex", model: "gpt-6-astra" },
      ],
    });

    expect(targets).toEqual([{ provider: "codex", model: "gpt-6-astra" }]);
  });
});

describe("toCompactPricing", () => {
  it("keeps the two headline rates the dashboard renders", () => {
    expect(toCompactPricing({ input: 10, output: 50, cached: 1, cache_creation: 12.5 }))
      .toEqual({ input: 10, output: 50 });
  });

  it("returns null when no price is known — the '未定价' signal", () => {
    // Must be distinguishable from a zero rate: `null` means "unknown", which is
    // what makes an unpriced model visible instead of silently costing $0.
    expect(toCompactPricing(null)).toBeNull();
    expect(toCompactPricing(undefined)).toBeNull();
    expect(toCompactPricing({})).toBeNull();
  });

  it("rejects a pricing object whose rates are not numbers", () => {
    expect(toCompactPricing({ input: "abc", output: "def" })).toBeNull();
    expect(toCompactPricing({ input: NaN, output: Infinity })).toBeNull();
  });

  it("accepts a numeric string, since Number() coerces it", () => {
    // Upstream catalogs sometimes emit rates as strings; coercing is right so
    // the model still bills correctly instead of showing as unpriced.
    expect(toCompactPricing({ input: "10", output: "50" })).toEqual({ input: 10, output: 50 });
  });

  it("keeps a partial rate rather than dropping the whole entry", () => {
    // Some catalog entries omit output. Showing the input rate still tells the
    // user this model is priced, which is the point of the badge.
    expect(toCompactPricing({ input: 3 })).toEqual({ input: 3, output: null });
    expect(toCompactPricing({ output: 15 })).toEqual({ input: null, output: 15 });
  });
});
