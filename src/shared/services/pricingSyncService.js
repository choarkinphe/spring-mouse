/**
 * Pricing synchronization service.
 *
 * Shared by the manual "sync pricing" action (POST /api/pricing/sync) and the
 * periodic scheduler, so the two can never drift.
 *
 * The scheduler imports this from the web process at startup; it must stay free
 * of `next/server` imports.
 */

import { getAdapter } from "@/lib/db/driver.js";
import { getCustomModels } from "@/lib/db/repos/aliasRepo.js";
import { getPricingForModel, updatePricing } from "@/lib/db/repos/pricingRepo.js";
import { fetchModelsDevCatalog, resetModelsDevCatalogCache } from "@/shared/utils/modelCatalog";
import { buildPricingFromCatalog, collectPricingTargets } from "@/shared/utils/pricingSync";

/**
 * Distinct (provider, model) pairs from real traffic. Needed because a channel
 * can serve models that were never synced into `customModels` — those are
 * exactly the ones most likely to be missing a price.
 */
async function readUsagePairs(db, providerId) {
  try {
    const rows = providerId
      ? db.all(`SELECT DISTINCT provider, model FROM usageHistory WHERE provider = ? AND model IS NOT NULL`, [providerId])
      : db.all(`SELECT DISTINCT provider, model FROM usageHistory WHERE model IS NOT NULL`);
    return rows || [];
  } catch {
    // usageHistory may not exist on a very fresh install — not fatal.
    return [];
  }
}

/**
 * Fill in missing model prices from the shared models.dev catalog.
 *
 * Never overwrites an existing price — see buildPricingFromCatalog. Only the
 * `-review`/`-max`/`-none` style variants whose wildcard match disagrees with
 * their base model are corrected.
 *
 * @param {object}  [options]
 * @param {string}  [options.providerId]  restrict to one channel
 * @param {boolean} [options.dryRun]      compute and report without writing
 * @param {boolean} [options.forceCatalogRefresh]
 *        Bypass the 10-minute catalog cache. Manual actions pass true (the user
 *        expects live upstream data); the scheduler leaves it false so a
 *        frequent interval does not hammer models.dev.
 * @returns {Promise<object>} summary; `ok: false` carries an `error` string
 */
export async function syncModelPricing({ providerId = null, dryRun = false, forceCatalogRefresh = false } = {}) {
  if (forceCatalogRefresh) resetModelsDevCatalogCache();

  const catalog = await fetchModelsDevCatalog();
  if (!catalog) {
    return { ok: false, error: "The model catalog is unreachable. Check outbound network access to models.dev." };
  }

  const db = await getAdapter();
  const [customModels, usagePairs] = await Promise.all([
    getCustomModels(),
    readUsagePairs(db, providerId),
  ]);

  const targets = collectPricingTargets({ customModels, usagePairs, providerId });
  if (targets.length === 0) {
    return { ok: true, total: 0, added: 0, fixed: 0, stats: null, unresolved: [], message: "No models to price for this channel." };
  }

  const { pricing, stats, unresolved } = await buildPricingFromCatalog(catalog, targets, {
    resolveCurrent: getPricingForModel,
  });

  const total = stats.added + stats.fixed;
  if (!dryRun && total > 0) await updatePricing(pricing);

  return {
    ok: true,
    dryRun,
    total,
    added: stats.added,
    fixed: stats.fixed,
    stats,
    // Truncated: the full list can be long and is only useful as a hint.
    unresolved: unresolved.slice(0, 50),
  };
}
