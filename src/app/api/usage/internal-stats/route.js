import { NextResponse } from "next/server";
import { getAdapter } from "@/lib/db/driver.js";

export const dynamic = "force-dynamic";

export async function GET(request) {
  try {
    const db = await getAdapter();
    // Keep statistics tied to the same retained window as request details.
    const recent = db.all(`SELECT usageHistory.requestId AS id, usageHistory.timestamp, usageHistory.startedAt, usageHistory.completedAt, usageHistory.provider, usageHistory.model, usageHistory.status, usageHistory.promptTokens, usageHistory.completionTokens, COALESCE(apiKeys.name, CASE WHEN usageHistory.apiKeyId = 'local-no-key' THEN '本地请求' ELSE '已删除的密钥' END) AS caller, CASE WHEN usageHistory.startedAt IS NOT NULL AND usageHistory.completedAt IS NOT NULL THEN MAX(0, ROUND((julianday(usageHistory.completedAt) - julianday(usageHistory.startedAt)) * 86400000)) ELSE NULL END AS durationMs FROM usageHistory LEFT JOIN apiKeys ON apiKeys.id = usageHistory.apiKeyId ORDER BY usageHistory.id DESC LIMIT 100`);
    const rows = db.all(
      `SELECT status, COUNT(*) AS count
         FROM (SELECT status FROM usageHistory ORDER BY id DESC LIMIT 100)
        GROUP BY status
        ORDER BY count DESC`,
      );
    const stats = { total: 0, success: 0, upstream: 0, blocked: 0, internal: 0, cancelled: 0, byStatus: [] };
    for (const row of rows) {
      const count = Number(row.count) || 0;
      const status = row.status || "unknown";
      stats.total += count;
      if (["success", "ok"].includes(status)) stats.success += count;
      // Terminally statuses are namespaced by origin, which is the distinction the
      // panel needs: did the upstream answer with an error, or did our own routing
      // policy stop the request? Legacy rows written before the split used the
      // bare "rejected" status for policy blocks, so they are folded in here.
      else if (status.startsWith("upstream:") || /^error:(429|5\d\d)$/.test(status)) stats.upstream += count;
      else if (status.startsWith("blocked:") || status === "rejected") stats.blocked += count;
      else if (status === "cancelled" || status === "error:499") stats.cancelled += count;
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
