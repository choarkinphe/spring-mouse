import { NextResponse } from "next/server";
import { getAdapter } from "@/lib/db/driver.js";

export const dynamic = "force-dynamic";

export async function GET(request) {
  try {
    const db = await getAdapter();
    const since = new URL(request.url).searchParams.get("since");
    const sinceIso = since ? new Date(since).toISOString() : null;
    const recent = db.all(`SELECT requestId AS id, timestamp, startedAt, completedAt, provider, model, status, promptTokens, completionTokens FROM usageHistory WHERE (? IS NULL OR timestamp >= ?) ORDER BY usageHistory.id DESC LIMIT 10`, [sinceIso, sinceIso]);
    const rows = db.all(
      `SELECT status, COUNT(*) AS count
         FROM (SELECT status FROM usageHistory WHERE (? IS NULL OR timestamp >= ?) ORDER BY id DESC LIMIT 100)
        GROUP BY status
        ORDER BY count DESC`,
      [sinceIso, sinceIso]);
    const stats = { total: 0, success: 0, upstream: 0, internal: 0, cancelled: 0, byStatus: [] };
    for (const row of rows) {
      const count = Number(row.count) || 0;
      const status = row.status || "unknown";
      stats.total += count;
      if (["success", "ok"].includes(status)) stats.success += count;
      else if (status.startsWith("upstream:")) stats.upstream += count;
      else if (status === "cancelled") stats.cancelled += count;
      else stats.internal += count;
      stats.byStatus.push({ status, count });
    }
    stats.recent = recent;
    return NextResponse.json(stats);
  } catch (error) {
    console.error("[API ERROR] /api/usage/internal-stats failed:", error);
    return NextResponse.json({ error: "Failed to fetch internal request stats" }, { status: 500 });
  }
}
