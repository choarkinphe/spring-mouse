import { NextResponse } from "next/server";
import { getUsageStats } from "@/lib/usageDb";

const VALID_PERIODS = new Set(["today", "24h", "7d", "30d", "60d", "all"]);

export const dynamic = "force-dynamic";

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const period = searchParams.get("period") || "7d";
    const startDate = searchParams.get("startDate");
    const endDate = searchParams.get("endDate");
    const apiKeyId = searchParams.get("apiKeyId") || null;

    if (!VALID_PERIODS.has(period)) {
      return NextResponse.json({ error: "Invalid period" }, { status: 400 });
    }
    if ((startDate && !endDate) || (!startDate && endDate) || (startDate && endDate && (Number.isNaN(Date.parse(startDate)) || Number.isNaN(Date.parse(endDate)) || Date.parse(startDate) > Date.parse(endDate)))) {
      return NextResponse.json({ error: "Invalid date range" }, { status: 400 });
    }
    if (apiKeyId && apiKeyId.length > 128) {
      return NextResponse.json({ error: "Invalid API key filter" }, { status: 400 });
    }

    const stats = await getUsageStats(period, { startDate, endDate, apiKeyId });
    return NextResponse.json(stats);
  } catch (error) {
    console.error("[API] Failed to get usage stats:", error);
    return NextResponse.json({ error: "Failed to fetch usage stats" }, { status: 500 });
  }
}
