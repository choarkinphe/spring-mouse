import { triggerManualUpdate, getUpdateStatus } from "@/lib/db/usageDailyUpdater";
import { NextResponse } from "next/server";

/**
 * Manual trigger for usageDaily batch updates
 * GET /api/usage/daily-update - trigger update and get status
 */
export async function GET() {
  try {
    // Trigger manual update
    const updateResult = await triggerManualUpdate();

    // Get current status
    const status = getUpdateStatus();

    return NextResponse.json({
      success: true,
      update: updateResult,
      status: status
    });
  } catch (error) {
    return NextResponse.json({
      success: false,
      error: error.message
    }, { status: 500 });
  }
}
