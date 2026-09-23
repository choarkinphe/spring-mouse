import { NextResponse } from "next/server";
import { syncModelPricing } from "@/shared/services/pricingSyncService";

export const dynamic = "force-dynamic";

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
    const result = await syncModelPricing({ providerId, dryRun, forceCatalogRefresh: true });

    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: 502 });
    }
    return NextResponse.json({
      success: true,
      dryRun: result.dryRun === true,
      total: result.total,
      added: result.added,
      fixed: result.fixed,
      stats: result.stats,
      unresolved: result.unresolved,
      ...(result.message ? { message: result.message } : {}),
    });
  } catch (error) {
    console.error("Failed to synchronize model pricing:", error);
    return NextResponse.json({ error: error.message || "Failed to synchronize model pricing" }, { status: 500 });
  }
}
