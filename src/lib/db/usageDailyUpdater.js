/**
 * Async usageDaily batch updater
 * Periodically aggregates usageHistory into usageDaily to improve query performance
 * without blocking real-time request processing.
 */

import { getAdapter } from "./driver.js";

// Local date key function (copied from usageRepo.js to avoid circular dependency)
function getLocalDateKey(timestamp) {
  const d = timestamp ? new Date(timestamp) : new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// Track last update time to avoid redundant processing
let lastUpdateTimestamp = 0;
const UPDATE_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes (configurable)
const UPDATE_BATCH_SIZE = 1000; // Process at most 1000 records per batch

/**
 * Calculate usageDaily aggregation from usageHistory for a specific date
 */
function aggregateDailyStats(db, targetDateKey) {
  const startDate = new Date(targetDateKey);
  const endDate = new Date(startDate);
  endDate.setDate(endDate.getDate() + 1);
  endDate.setHours(0, 0, 0, 0);

  // First get total count and totals for the date
  const totals = db.get(
    `SELECT
       COUNT(*) as requests,
       SUM(promptTokens) as promptTokens,
       SUM(completionTokens) as completionTokens,
       SUM(cachedTokens) as cachedTokens,
       SUM(cost) as cost
     FROM usageHistory
     WHERE timestamp >= ? AND timestamp < ?`,
    [startDate.toISOString(), endDate.toISOString()]
  );

  if (!totals || totals.requests === 0) {
    return { success: true, message: "No data found for this date", records: 0 };
  }

  // Then get breakdown by provider
  const rows = db.all(
    `SELECT
       provider,
       COUNT(*) as requests,
       SUM(promptTokens) as promptTokens,
       SUM(completionTokens) as completionTokens,
       SUM(cachedTokens) as cachedTokens,
       SUM(cost) as cost
     FROM usageHistory
     WHERE timestamp >= ? AND timestamp < ?
     GROUP BY provider`,
    [startDate.toISOString(), endDate.toISOString()]
  );

  // Build dayData structure compatible with reading logic
  const dayData = {
    dateKey: targetDateKey,
    promptTokens: totals.promptTokens || 0,
    completionTokens: totals.completionTokens || 0,
    cachedTokens: totals.cachedTokens || 0,
    cost: totals.cost || 0,
    requests: totals.requests || 0,
    stats: {},
    byProvider: {},
    byModel: {},
    byApiKey: {},
    byAccount: {},
    bySourceIp: {},
    byApp: {},
    byUser: {}
  };

  // Aggregate by provider (totals already set, just build breakdown)
  for (const row of rows) {
    const provider = row.provider || "unknown";

    // Don't update totals here - already set from the totals query

    // Update nested stats structure
    if (!dayData.stats[provider]) {
      dayData.stats[provider] = {
        requests: 0,
        promptTokens: 0,
        completionTokens: 0,
        cachedTokens: 0,
        cost: 0
      };
    }
    dayData.stats[provider].requests += row.requests || 0;
    dayData.stats[provider].promptTokens += row.promptTokens || 0;
    dayData.stats[provider].completionTokens += row.completionTokens || 0;
    dayData.stats[provider].cachedTokens += row.cachedTokens || 0;
    dayData.stats[provider].cost += row.cost || 0;

    // Sync flat structure for compatibility
    if (!dayData.byProvider[provider]) {
      dayData.byProvider[provider] = {
        requests: 0,
        promptTokens: 0,
        completionTokens: 0,
        cachedTokens: 0,
        cost: 0
      };
    }
    dayData.byProvider[provider].requests += row.requests || 0;
    dayData.byProvider[provider].promptTokens += row.promptTokens || 0;
    dayData.byProvider[provider].completionTokens += row.completionTokens || 0;
    dayData.byProvider[provider].cachedTokens += row.cachedTokens || 0;
    dayData.byProvider[provider].cost += row.cost || 0;
  }

  // Write aggregated data to usageDaily
  db.run(
    `INSERT INTO usageDaily (dateKey, data) VALUES (?, ?) ON CONFLICT (dateKey) DO UPDATE SET data = excluded.data`,
    [targetDateKey, JSON.stringify(dayData)]
  );

  return { success: true, message: "Updated successfully", records: rows.length };
}

/**
 * Update usageDaily for recent dates that might be incomplete
 * Updates today and yesterday to ensure recent stats are reasonably current
 */
export async function updateRecentDailyStats() {
  try {
    const db = await getAdapter();
    const now = new Date();

    // Update today and yesterday to keep recent stats reasonably current
    const datesToUpdate = [
      getLocalDateKey(now), // Today
      getLocalDateKey(new Date(now.getTime() - 24 * 60 * 60 * 1000)) // Yesterday
    ];

    console.log(`[UsageDaily] Starting batch update for dates: ${datesToUpdate.join(", ")}`);

    let totalUpdated = 0;
    for (const dateKey of datesToUpdate) {
      try {
        const result = aggregateDailyStats(db, dateKey);
        if (result.success && result.records > 0) {
          totalUpdated += result.records;
          console.log(`[UsageDaily] Updated ${dateKey}: ${result.records} provider groups aggregated`);
        } else if (result.message) {
          console.log(`[UsageDaily] ${dateKey}: ${result.message}`);
        }
      } catch (error) {
        console.error(`[UsageDaily] Failed to update ${dateKey}:`, error.message);
      }
    }

    lastUpdateTimestamp = Date.now();
    console.log(`[UsageDaily] Batch update completed: ${totalUpdated} total records processed`);

    return {
      success: true,
      totalUpdated,
      datesUpdated: datesToUpdate.length
    };
  } catch (error) {
    console.error("[UsageDaily] Batch update failed:", error);
    return { success: false, error: error.message };
  }
}

/**
 * Start periodic usageDaily updates
 * Runs every UPDATE_INTERVAL_MS to keep daily summaries reasonably current
 */
export function startPeriodicUpdates() {
  // Don't start multiple timers
  if (global._usageDailyUpdateTimer) {
    console.log("[UsageDaily] Periodic updates already running");
    return;
  }

  console.log(`[UsageDaily] Starting periodic updates every ${UPDATE_INTERVAL_MS / 60000} minutes`);

  const updateFunction = async () => {
    try {
      await updateRecentDailyStats();
    } catch (error) {
      console.error("[UsageDaily] Scheduled update failed:", error);
    }
  };

  // Run immediately on start, then schedule
  updateFunction().catch(() => {}); // Ignore startup errors
  global._usageDailyUpdateTimer = setInterval(updateFunction, UPDATE_INTERVAL_MS);
}

/**
 * Manually trigger an update (useful for testing or immediate needs)
 */
export async function triggerManualUpdate() {
  console.log("[UsageDaily] Manual update triggered");
  return await updateRecentDailyStats();
}

/**
 * Stop periodic updates (useful for maintenance or testing)
 */
export function stopPeriodicUpdates() {
  if (global._usageDailyUpdateTimer) {
    clearInterval(global._usageDailyUpdateTimer);
    global._usageDailyUpdateTimer = null;
    console.log("[UsageDaily] Periodic updates stopped");
  }
}

/**
 * Get status of periodic updates
 */
export function getUpdateStatus() {
  return {
    running: !!global._usageDailyUpdateTimer,
    interval: UPDATE_INTERVAL_MS,
    lastUpdate: new Date(lastUpdateTimestamp).toISOString(),
    nextUpdate: new Date(lastUpdateTimestamp + UPDATE_INTERVAL_MS).toISOString()
  };
}