import { NextResponse } from "next/server";
import { getAdapter } from "@/lib/db/driver.js";
import { getCustomModels } from "@/lib/db/repos/aliasRepo.js";
import { getPricingForModel, updatePricing } from "@/lib/db/repos/pricingRepo.js";
import { fetchModelsDevCatalog, resetModelsDevCatalogCache } from "@/shared/utils/modelCatalog";
import { buildPricingFromCatalog, collectPricingTargets } from "@/shared/utils/pricingSync";

export const dynamic = "force-dynamic";

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
 * POST /api/pricing/sync
 *
 * Fill in missing model prices from the shared models.dev catalog.
 *
 * Body (optional):
 *   { providerId?: string, dryRun?: boolean }
 *
 * Never overwrites an existing price — see buildPricingFromCatalog. Only the
 * `-review`/`-max`/`-none` style variants whose wildcard match disagrees with
 * their base model are corrected.
 */
export async function POST(request) {
  try {
    const body = await request.json().catch(() => ({}));
    const providerId = body?.providerId || null;
    const dryRun = body?.dryRun === true;

    // A manual action must observe upstream truth, not a cache filled by an
    // earlier "sync models" click.
    resetModelsDevCatalogCache();
    const catalog = await fetchModelsDevCatalog();
    if (!catalog) {
      return NextResponse.json(
        { error: "The model catalog is unreachable. Check outbound network access to models.dev." },
        { status: 502 },
      );
    }

    const db = await getAdapter();
    const [customModels, usagePairs] = await Promise.all([
      getCustomModels(),
      readUsagePairs(db, providerId),
    ]);

    const targets = collectPricingTargets({ customModels, usagePairs, providerId });
    if (targets.length === 0) {
      return NextResponse.json({ success: true, total: 0, stats: null, message: "No models to price for this channel." });
    }

    const { pricing, stats, unresolved } = await buildPricingFromCatalog(catalog, targets, {
      resolveCurrent: getPricingForModel,
    });

    const total = stats.added + stats.fixed;
    if (dryRun) {
      return NextResponse.json({ success: true, dryRun: true, total, stats, unresolved: unresolved.slice(0, 50) });
    }

    if (total > 0) await updatePricing(pricing);

    return NextResponse.json({
      success: true,
      total,
      added: stats.added,
      fixed: stats.fixed,
      stats,
      // Truncated: the full list can be long and is only useful as a hint.
      unresolved: unresolved.slice(0, 50),
    });
  } catch (error) {
    console.error("Failed to synchronize model pricing:", error);
    return NextResponse.json({ error: error.message || "Failed to synchronize model pricing" }, { status: 500 });
  }
}
