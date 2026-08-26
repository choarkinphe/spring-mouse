import { triggerManualUpdate } from "@/lib/db/usageDailyUpdater";
import { NextResponse } from "next/server";

/**
 * Manual trigger for usageDaily batch updates
 * POST /api/usage/trigger-update - trigger immediate update
 */
export async function POST() {
  try {
    console.log("[API] Manual usageDaily update triggered via API");

    // Trigger manual update
    const updateResult = await triggerManualUpdate();

    return NextResponse.json({
      success: true,
      message: "UsageDaily update triggered successfully",
      result: updateResult,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error("[API] Manual update failed:", error);
    return NextResponse.json({
      success: false,
      error: error.message,
      timestamp: new Date().toISOString()
    }, { status: 500 });
  }
}