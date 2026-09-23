import { NextResponse } from "next/server";
import { backfillUsageCost } from "@/lib/db/repos/usageRepo.js";

export const dynamic = "force-dynamic";
// A full-table backfill on a large install scans hundreds of thousands of rows.
// The route is explicit and manual, so it gets a generous budget; callers can
// narrow the scope with `provider` to keep it short.
export const maxDuration = 300;

/**
 * POST /api/pricing/backfill
 *
 * Recompute historical `usageHistory.cost` using the current pricing tables.
 *
 * Cost is stored once at write time, so any model that had no price back then
 * keeps a `0` forever — adding the price later does not repair the history.
 * This is the explicit repair path. It REWRITES BILLING FIGURES, so it is never
 * automatic and always supports a dry run.
 *
 * Body (all optional):
 *   { dryRun?: boolean, provider?: string, batchSize?: number, maxRows?: number }
 *
 * Start with `dryRun: true` to see the impact, then repeat without it to apply.
 */
export async function POST(request) {
  try {
    const body = await request.json().catch(() => ({}));
    const dryRun = body?.dryRun === true;
    const provider = typeof body?.provider === "string" && body.provider.trim() ? body.provider.trim() : null;
    const batchSize = Number(body?.batchSize) || 2000;
    const maxRows = Number(body?.maxRows) || 0;

    const started = Date.now();
    const summary = await backfillUsageCost({ dryRun, provider, batchSize, maxRows });
    const elapsedMs = Date.now() - started;

    // Largest movers first — the UI shows a few and this is the useful ordering.
    const topModels = Object.entries(summary.byModel)
      .map(([model, entry]) => ({ model, ...entry, delta: Number((entry.after - entry.before).toFixed(6)) }))
      .sort((a, b) => b.delta - a.delta)
      .slice(0, 25);

    return NextResponse.json({
      success: true,
      dryRun,
      elapsedMs,
      scanned: summary.scanned,
      changed: summary.changed,
      unchanged: summary.unchanged,
      // Rows the pricing tables still cannot price. Surfaced deliberately so a
      // model missing a price stays visible rather than looking "repaired".
      unpriced: summary.unpriced,
      costBefore: Number(summary.costBefore.toFixed(4)),
      costAfter: Number(summary.costAfter.toFixed(4)),
      delta: Number(summary.delta.toFixed(4)),
      topModels,
    });
  } catch (error) {
    console.error("Failed to backfill usage cost:", error);
    return NextResponse.json({ error: error.message || "Failed to backfill usage cost" }, { status: 500 });
  }
}
