import { NextResponse } from "next/server";
import { getUsageStats } from "@/lib/usageDb";
import { resolveUsageDashboardScope } from "@/lib/usageDashboardScope";

const NO_STORE_HEADERS = { "Cache-Control": "no-store, max-age=0" };

const VALID_PERIODS = new Set(["today", "24h", "7d", "30d", "60d", "all"]);

export const dynamic = "force-dynamic";

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const period = searchParams.get("period") || "7d";
    const startDate = searchParams.get("startDate");
    const endDate = searchParams.get("endDate");
    const apiKeyId = searchParams.get("apiKeyId") || null;
    const scope = searchParams.get("scope");

    if (!VALID_PERIODS.has(period)) {
      return NextResponse.json({ error: "Invalid period" }, { status: 400, headers: NO_STORE_HEADERS });
    }
    if ((startDate && !endDate) || (!startDate && endDate) || (startDate && endDate && (Number.isNaN(Date.parse(startDate)) || Number.isNaN(Date.parse(endDate)) || Date.parse(startDate) > Date.parse(endDate)))) {
      return NextResponse.json({ error: "Invalid date range" }, { status: 400, headers: NO_STORE_HEADERS });
    }
    if (apiKeyId && apiKeyId.length > 128) {
      return NextResponse.json({ error: "Invalid API key filter" }, { status: 400, headers: NO_STORE_HEADERS });
    }

    // The persisted tag scope is an opt-in view filter for the usage page.
    // The dashboard home page intentionally omits it so its live overview always
    // reflects all real connections.
    const { apiKeyIds } = scope === "dashboard"
      ? await resolveUsageDashboardScope(apiKeyId)
      : { apiKeyIds: apiKeyId ? [apiKeyId] : null };
    const stats = await getUsageStats(period, { startDate, endDate, apiKeyId, apiKeyIds });
    return NextResponse.json(stats, { headers: NO_STORE_HEADERS });
  } catch (error) {
    console.error("[API] Failed to get usage stats:", error);
    return NextResponse.json({ error: "Failed to fetch usage stats" }, { status: 500, headers: NO_STORE_HEADERS });
  }
}
