import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";
import { makeKv } from "../helpers/kvStore.js";
import { deleteHotJson } from "@/lib/redis/hotCache.js";

const pricingKv = makeKv("pricing");
const CACHE_TTL_MS = 5000;

// `pricingKv.getAll()` backfills a Redis hot snapshot with a 120s TTL, so the
// module-local cache below is not the only stale layer. Every writer must also
// drop that snapshot or pricing changes take up to two minutes to be visible
// (and are invisible to other processes for the same window).
const PRICING_CACHE_KEY = "kv:pricing";

let cache = { value: null, expiresAt: 0 };

function invalidate() {
  cache = { value: null, expiresAt: 0 };
}

async function invalidateAll() {
  invalidate();
  await deleteHotJson(PRICING_CACHE_KEY).catch(() => {});
}

async function getUserPricing() {
  return await pricingKv.getAll();
}

export async function getPricing() {
  const now = Date.now();
  if (cache.value && cache.expiresAt > now) return cache.value;

  const userPricing = await getUserPricing();
  const { PROVIDER_PRICING } = await import("open-sse/providers/pricing.js");
  const merged = {};

  for (const [provider, models] of Object.entries(PROVIDER_PRICING)) {
    merged[provider] = { ...models };
    if (userPricing[provider]) {
      for (const [model, pricing] of Object.entries(userPricing[provider])) {
        merged[provider][model] = merged[provider][model]
          ? { ...merged[provider][model], ...pricing }
          : pricing;
      }
    }
  }

  for (const [provider, models] of Object.entries(userPricing)) {
    if (!merged[provider]) {
      merged[provider] = { ...models };
    } else {
      for (const [model, pricing] of Object.entries(models)) {
        if (!merged[provider][model]) merged[provider][model] = pricing;
      }
    }
  }

  cache = { value: merged, expiresAt: now + CACHE_TTL_MS };
  return merged;
}

export async function getPricingForModel(provider, model) {
  if (!model) return null;
  // 复用缓存的 getPricing() 而非直接读 KV，避免每请求全量扫描 pricing scope
  const allPricing = await getPricing();
  if (provider && allPricing[provider]?.[model]) return allPricing[provider][model];
  const { getPricingForModel: resolveConst } = await import("open-sse/providers/pricing.js");
  return resolveConst(provider, model);
}

/**
 * Resolve pricing for many (provider, model) pairs in one pass.
 *
 * `getPricingForModel` re-enters `getPricing()` per call, which is fine for a
 * single lookup but wasteful when annotating a whole model list (~1300 entries
 * on /api/models). This reads the merged table once and falls back to the
 * static resolver for anything the merge layer does not carry.
 *
 * @param {Array<{provider: string, model: string}>} entries
 * @returns {Promise<Map<string, object|null>>} keyed by `${provider}/${model}`
 */
export async function getPricingForModels(entries = []) {
  const allPricing = await getPricing();
  const { getPricingForModel: resolveConst } = await import("open-sse/providers/pricing.js");
  const out = new Map();
  for (const entry of entries) {
    const provider = entry?.provider;
    const model = entry?.model;
    if (!model) continue;
    const key = `${provider || ""}/${model}`;
    if (out.has(key)) continue;
    const merged = provider ? allPricing[provider]?.[model] : null;
    out.set(key, merged || resolveConst(provider, model));
  }
  return out;
}

// Atomic merge inside transaction (per-provider read-modify-write)
export async function updatePricing(pricingData) {
  const db = await getAdapter();
  db.transaction(() => {
    for (const [provider, models] of Object.entries(pricingData)) {
      const row = db.get(`SELECT value FROM kv WHERE scope = 'pricing' AND key = ?`, [provider]);
      const current = row ? (parseJson(row.value, {}) || {}) : {};
      const merged = { ...current };
      for (const [model, pricing] of Object.entries(models)) {
        merged[model] = pricing;
      }
      db.run(
        `INSERT INTO kv(scope, key, value) VALUES('pricing', ?, ?) ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value`,
        [provider, stringifyJson(merged)]
      );
    }
  });
  await invalidateAll();
  return await getUserPricing();
}

export async function resetPricing(provider, model) {
  if (!provider) return await getUserPricing();
  const db = await getAdapter();
  db.transaction(() => {
    if (!model) {
      db.run(`DELETE FROM kv WHERE scope = 'pricing' AND key = ?`, [provider]);
      return;
    }
    const row = db.get(`SELECT value FROM kv WHERE scope = 'pricing' AND key = ?`, [provider]);
    const current = row ? (parseJson(row.value, {}) || {}) : {};
    delete current[model];
    if (Object.keys(current).length === 0) {
      db.run(`DELETE FROM kv WHERE scope = 'pricing' AND key = ?`, [provider]);
    } else {
      db.run(
        `INSERT INTO kv(scope, key, value) VALUES('pricing', ?, ?) ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value`,
        [provider, stringifyJson(current)]
      );
    }
  });
  await invalidateAll();
  return await getUserPricing();
}

export async function resetAllPricing() {
  await pricingKv.clear();
  await invalidateAll();
  return {};
}
