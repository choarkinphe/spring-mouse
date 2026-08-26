import { getAdapter } from "@/lib/db/driver.js";
import { getUpdateStatus } from "@/lib/db/usageDailyUpdater";
import { NextResponse } from "next/server";

/**
 * Diagnostic endpoint for usageDaily and usageHistory status
 * GET /api/usage/diag - check system status and data availability
 */
export async function GET() {
  try {
    const db = await getAdapter();
    const now = new Date();
    const todayKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;

    // Check usageDaily updater status
    const updaterStatus = getUpdateStatus();

    // Check if usageDaily table exists and has today's data
    let dailyTableExists = false;
    let todayDailyData = null;
    let dailyRecordCount = 0;

    try {
      const tables = db.all("SELECT name FROM sqlite_master WHERE type='table' AND name='usageDaily'");
      dailyTableExists = tables.length > 0;

      if (dailyTableExists) {
        const todayRecord = db.get("SELECT data FROM usageDaily WHERE dateKey = ?", [todayKey]);
        if (todayRecord && todayRecord.data) {
          try {
            todayDailyData = JSON.parse(todayRecord.data);
            dailyRecordCount = todayDailyData.requests || 0;
          } catch (e) {
            todayDailyData = { error: "Failed to parse data" };
          }
        }
      }
    } catch (e) {
      dailyTableExists = false;
    }

    // Check usageHistory for today's data
    let historyTableExists = false;
    let todayHistoryCount = 0;
    let recentHistorySample = [];

    try {
      const tables = db.all("SELECT name FROM sqlite_master WHERE type='table' AND name='usageHistory'");
      historyTableExists = tables.length > 0;

      if (historyTableExists) {
        // Count today's records
        const todayStart = new Date(now);
        todayStart.setHours(0, 0, 0, 0);
        const todayEnd = new Date(todayStart);
        todayEnd.setDate(todayEnd.getDate() + 1);

        const countResult = db.get(
          "SELECT COUNT(*) as count FROM usageHistory WHERE timestamp >= ? AND timestamp < ?",
          [todayStart.toISOString(), todayEnd.toISOString()]
        );
        todayHistoryCount = countResult ? countResult.count : 0;

        // Get recent sample (last 5 requests)
        const recentRecords = db.all(
          "SELECT timestamp, provider, model, promptTokens, completionTokens FROM usageHistory ORDER BY timestamp DESC LIMIT 5"
        );
        recentHistorySample = recentRecords.map(record => ({
          ...record,
          timeAgo: getTimeAgo(new Date(record.timestamp))
        }));
      }
    } catch (e) {
      historyTableExists = false;
    }

    // Check recent data (last 1 hour)
    let recentHourCount = 0;
    if (historyTableExists) {
      const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
      const hourResult = db.get(
        "SELECT COUNT(*) as count FROM usageHistory WHERE timestamp >= ?",
        [oneHourAgo.toISOString()]
      );
      recentHourCount = hourResult ? hourResult.count : 0;
    }

    return NextResponse.json({
      success: true,
      timestamp: now.toISOString(),
      todayDateKey: todayKey,
      diagnosis: {
        tables: {
          usageDaily: {
            exists: dailyTableExists,
            hasTodayData: !!todayDailyData,
            recordCount: dailyRecordCount
          },
          usageHistory: {
            exists: historyTableExists,
            todayCount: todayHistoryCount,
            recentHourCount: recentHourCount,
            recentSample: recentHistorySample
          }
        },
        updater: updaterStatus,
        issues: diagnoseIssues({
          dailyTableExists,
          todayDailyData,
          historyTableExists,
          todayHistoryCount,
          recentHourCount,
          updaterStatus
        })
      }
    });
  } catch (error) {
    return NextResponse.json({
      success: false,
      error: error.message,
      stack: error.stack
    }, { status: 500 });
  }
}

function getTimeAgo(date) {
  const now = new Date();
  const diffMs = now - date;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);

  if (diffMins < 1) return "刚刚";
  if (diffMins < 60) return `${diffMins}分钟前`;
  if (diffHours < 24) return `${diffHours}小时前`;
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}天前`;
}

function diagnoseIssues(status) {
  const issues = [];

  if (!status.historyTableExists) {
    issues.push("CRITICAL: usageHistory 表不存在，数据记录功能可能完全失效");
  }

  if (!status.dailyTableExists) {
    issues.push("WARNING: usageDaily 表不存在，日汇总功能不可用");
  }

  if (status.historyTableExists && status.todayHistoryCount === 0) {
    issues.push("ISSUE: 今天没有 usageHistory 记录，可能没有新的API请求");
  }

  if (status.historyTableExists && status.todayHistoryCount > 0 && !status.todayDailyData) {
    issues.push("ISSUE: usageHistory 有今天数据但 usageDaily 没有，批量更新器可能未运行");
  }

  if (status.historyTableExists && status.recentHourCount === 0 && status.todayHistoryCount > 0) {
    issues.push("INFO: 最近1小时没有新请求，今天的数据都较久远");
  }

  if (!status.updaterStatus.running) {
    issues.push("WARNING: usageDaily 更新器未运行，需要手动触发或重启服务");
  }

  return issues;
}