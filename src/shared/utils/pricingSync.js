/**
 * Build pricing overrides from the shared models.dev catalog.
 *
 * WHY: `open-sse/providers/pricing.js` is a hand-maintained static table. Models
 * added upstream never get a price, so `getPricingForModel` returns null and
 * `calculateCost` silently records $0. On the production DB this had accumulated
 * to 2.66B unbilled prompt tokens for `codex/gpt-6-astra` alone.
 *
 * models.dev already ships `cost` on 94.7% of its models and this repo already
 * fetches that catalog for capability sync — `parseModelsDevCatalog` simply
 * discarded the `cost` field. This module reads it.
 *
 * Field mapping:
 *   models.dev  { input, output, reasoning, cache_read, cache_write }
 *   local       { input, output, reasoning, cached,     cache_creation }
 *
 * Match strategy is two-tier, because neither tier alone is sufficient
 * (measured on the production DB: provider-map only covers 18/104 groups and
 * leaves 21.6B tokens unmatched; adding the global fallback covers 76/104 and
 * leaves 8.9M — 99.99% of traffic):
 *
 *   1. provider-mapped exact match   — `MODELS_DEV_PROVIDER_KEYS[provider]` → catalog provider
 *   2. global model-id fallback      — same model id under any catalog provider
 *
 * Tier 2 is required: `glm-cn`'s main model `glm-5.2` is absent from its mapped
 * `zhipuai-coding-plan` but present under `zai-coding-plan`; `codebuddy-*` and
 * `openai-compatible-*` channels have no mapping at all.
 */

import { resolveProviderAlias } from "open-sse/services/model.js";
import { getPricingForModel, MODEL_PRICING, PROVIDER_PRICING } from "open-sse/providers/pricing.js";
import { MODELS_DEV_PROVIDER_KEYS } from "./modelCatalog.js";

// Only these five fields are persisted; /api/pricing enforces the same set.
const PRICING_FIELDS = ["input", "output", "cached", "reasoning", "cache_creation"];

// Suffixes that mark a variant of a base model. `upstreamModelId` in the registry
// expresses the same relation for outbound requests, but the usage row records
// the variant id, so pricing must resolve through the base.
const VARIANT_SUFFIXES = ["-review", "-max", "-none", "-high", "-low", "-medium", "-xhigh"];

/**
 * Coerce a raw catalog cost object into the local pricing shape.
 * Rejects anything that is not a finite non-negative number — a string would
 * make `calculateCostFromTokens` produce NaN and persist it.
 */
function toLocalPricing(rawCost) {
  if (!rawCost || typeof rawCost !== "object") return null;

  const mapped = {
    input: rawCost.input,
    output: rawCost.output,
    cached: rawCost.cache_read,
    cache_creation: rawCost.cache_write,
    reasoning: rawCost.reasoning,
  };

  const clean = {};
  for (const field of PRICING_FIELDS) {
    const value = mapped[field];
    if (value === undefined || value === null) continue;
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric < 0) return null;
    clean[field] = numeric;
  }

  // A price with no input AND no output rate is not usable (some aggregators
  // publish all-zero placeholder entries, e.g. alibaba-token-plan).
  if (!clean.input && !clean.output) return null;
  if (clean.reasoning === undefined && clean.output !== undefined) clean.reasoning = clean.output;

  return clean;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Pick one price for a model id that appears under several catalog providers.
 * Prices vary widely between resellers (e.g. glm-5.2: zai 1.4/4.4 vs crof
 * 0.3/1.05), so the median is more stable than first-wins, which would let an
 * outlier low price dominate.
 */
function pickMedianPricing(costs) {
  if (costs.length === 1) return costs[0];
  const picked = {};
  for (const field of PRICING_FIELDS) {
    const values = costs.map((c) => c[field]).filter((v) => typeof v === "number");
    if (values.length) picked[field] = median(values);
  }
  return picked.input || picked.output ? picked : null;
}

/**
 * Build a global index of every priced model id in the catalog.
 * @returns {Map<string, object>} modelId → median pricing
 */
function buildGlobalIndex(catalog) {
  const byModel = new Map();
  for (const provider of Object.values(catalog || {})) {
    if (!provider?.models || typeof provider.models !== "object") continue;
    for (const [modelId, model] of Object.entries(provider.models)) {
      const pricing = toLocalPricing(model?.cost);
      if (!pricing) continue;
      const list = byModel.get(modelId) || [];
      list.push(pricing);
      byModel.set(modelId, list);
    }
  }

  const index = new Map();
  for (const [modelId, costs] of byModel) {
    const picked = pickMedianPricing(costs);
    if (picked) index.set(modelId, picked);
  }
  return index;
}

/** Look up a model id in one mapped catalog provider. */
function lookupInProvider(catalog, providerKey, modelId) {
  return toLocalPricing(catalog?.[providerKey]?.models?.[modelId]?.cost);
}

/**
 * Resolve pricing for one (provider, model) pair, or null when the catalog has
 * nothing usable. Tier 1 (provider mapping) wins over tier 2 (global index).
 */
function resolveFromCatalog(catalog, globalIndex, provider, model) {
  const providerKey = MODELS_DEV_PROVIDER_KEYS[provider];
  if (providerKey) {
    const hit = lookupInProvider(catalog, providerKey, model);
    if (hit) return { pricing: hit, via: "provider" };
  }
  const global = globalIndex.get(model);
  if (global) return { pricing: global, via: "global" };
  return null;
}

/**
 * Look up a price from the CURATED tables only (MODEL_PRICING / PROVIDER_PRICING),
 * bypassing the wildcard PATTERN_PRICING tier. Used to tell an explicitly
 * authored price apart from one that only matched a glob.
 */
function getExplicitPricing(provider, model) {
  if (!model) return null;
  if (provider && PROVIDER_PRICING[provider]?.[model]) return PROVIDER_PRICING[provider][model];
  const base = model.includes("/") ? model.split("/").pop() : model;
  return MODEL_PRICING[base] || MODEL_PRICING[model] || null;
}

/**
 * Strip a variant suffix, returning candidate base ids.
 * "gpt-5.6-sol-review" → ["gpt-5.6-sol"]
 */
function baseModelCandidates(model) {
  const candidates = [];
  for (const suffix of VARIANT_SUFFIXES) {
    if (model.endsWith(suffix) && model.length > suffix.length) {
      candidates.push(model.slice(0, -suffix.length));
    }
  }
  return candidates;
}

/**
 * Decide whether `model` is a variant that was priced by a wildcard and whose
 * base model has an authored price. Returns the base price to adopt, or null.
 *
 * Two guards keep this from corrupting correct prices:
 *  - the variant itself must NOT have an explicit price. `gpt-5.1-codex-max` is
 *    a real, separately-priced model (8/32); stripping `-max` would wrongly
 *    repoint it at `gpt-5.1-codex` (1.25/10).
 *  - the base must have an explicit price. Preferring the repo's own curated
 *    rate over the catalog keeps the correction consistent with the static
 *    table (models.dev's `openai` lists sol at 4/20 while this repo curates
 *    5/30 — the repo value is the one already used for sol itself).
 */
function resolveVariantCorrection(provider, model) {
  if (getExplicitPricing(provider, model)) return null;

  for (const base of baseModelCandidates(model)) {
    const explicit = getExplicitPricing(provider, base);
    if (explicit) return explicit;
  }
  return null;
}

function samePricing(a, b) {
  if (!a || !b) return false;
  return PRICING_FIELDS.every((field) => a[field] === b[field]);
}

/**
 * Build pricing overrides for the given channels from the models.dev catalog.
 *
 * Never overwrites an existing price: a model that already resolves to a price
 * is skipped, so hand-tuned overrides and the static `MODEL_PRICING` /
 * `PATTERN_PRICING` tables are preserved. The one exception is a variant whose
 * current price disagrees with its base model — that is a wildcard mis-match
 * (measured: `gpt-5.6-sol-review` resolves to 2.5/15 via the `gpt-5.6-*` glob
 * instead of sol's 5/30) and is corrected.
 *
 * `resolveCurrent` MUST be the runtime resolver (pricingRepo.getPricingForModel,
 * which merges the user pricing KV *and* the static tables). Passing only the
 * static open-sse resolver would treat a hand-tuned KV price as "missing" and
 * overwrite it, because `getPricingForModel` prefers KV over everything else.
 *
 * @param {object}   catalog                 models.dev payload
 * @param {Array}    targets                 [{ provider, model }] — provider is a registry id
 * @param {object}   [options]
 * @param {Function} [options.resolveCurrent] (provider, model) => pricing|null
 * @returns {Promise<{ pricing: object, stats: object, unresolved: Array }>}
 */
export async function buildPricingFromCatalog(catalog, targets = [], { resolveCurrent = getPricingForModel } = {}) {
  const globalIndex = buildGlobalIndex(catalog);
  const pricing = {};
  const stats = { scanned: 0, added: 0, fixed: 0, skippedExisting: 0, skippedNoCost: 0, unresolved: 0 };
  const unresolved = [];

  for (const target of targets) {
    const model = target?.model;
    if (!model) continue;
    // Callers pass either form; normalize so the written key matches what
    // usage rows and getPricingForModel look up (registry id).
    const provider = resolveProviderAlias(target.provider);
    if (!provider) continue;

    stats.scanned += 1;

    // 1. A variant that only matched a wildcard adopts its base model's authored
    //    price. Checked first because it must win over the catalog value.
    const correction = resolveVariantCorrection(provider, model);
    if (correction) {
      const current = await resolveCurrent(provider, model);
      if (!samePricing(current, correction)) {
        pricing[provider] ||= {};
        pricing[provider][model] = correction;
        stats.fixed += 1;
      } else {
        stats.skippedExisting += 1;
      }
      continue;
    }

    // 2. Anything already priced is left untouched — this is what protects the
    //    static tables and hand-tuned overrides. Checked before the catalog so a
    //    priced model is never miscounted as "no catalog price" just because
    //    models.dev happens to lack it.
    if (await resolveCurrent(provider, model)) {
      stats.skippedExisting += 1;
      continue;
    }

    // 3. Unpriced: fill from the catalog (provider mapping first, global index
    //    second, then a variant-suffix retry).
    const resolved = resolveFromCatalog(catalog, globalIndex, provider, model);
    const baseHit = !resolved
      ? baseModelCandidates(model)
          .map((base) => resolveFromCatalog(catalog, globalIndex, provider, base))
          .find(Boolean)
      : null;
    const found = resolved || baseHit;

    if (!found) {
      stats.skippedNoCost += 1;
      unresolved.push({ provider, model });
      continue;
    }

    pricing[provider] ||= {};
    pricing[provider][model] = found.pricing;
    stats.added += 1;
  }

  stats.unresolved = unresolved.length;
  return { pricing, stats, unresolved };
}

/**
 * Collect every (provider, model) pair worth pricing for a channel, from both
 * the channel's model list and its real traffic history.
 *
 * The two sources disagree on provider form — `customModels.providerAlias` holds
 * the alias (`cx`), `usageHistory.provider` holds the registry id (`codex`) — so
 * both are normalized through `resolveProviderAlias` before use.
 *
 * @param {object} input
 * @param {Array}  input.customModels  rows from getCustomModels()
 * @param {Array}  input.usagePairs    [{ provider, model }] from usageHistory
 * @param {string} [input.providerId]  restrict to one channel (registry id or alias)
 * @returns {Array<{provider: string, model: string}>} de-duplicated
 */
export function collectPricingTargets({ customModels = [], usagePairs = [], providerId = null } = {}) {
  const wanted = providerId ? resolveProviderAlias(providerId) : null;
  const seen = new Set();
  const targets = [];

  const push = (provider, model) => {
    if (!provider || !model) return;
    // Rows without a provider come from non-billing endpoints (count_tokens,
    // image generation). Writing a `null/<model>` price key would be junk.
    if (typeof provider !== "string") return;
    const id = resolveProviderAlias(provider);
    if (wanted && id !== wanted) return;
    const key = `${id}|${model}`;
    if (seen.has(key)) return;
    seen.add(key);
    targets.push({ provider: id, model });
  };

  for (const row of customModels) push(row?.providerAlias, row?.id);
  for (const row of usagePairs) push(row?.provider, row?.model);

  return targets;
}
