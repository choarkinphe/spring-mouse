/**
 * Rollup-backed stats assembly.
 *
 * Produces the SAME stats object as `runAggregation` (usage-aggregate.mjs), but
 * from `usageRollupDay` instead of scanning `usageHistory`. One table serves
 * both halves: the six aggregate dimensions and `byUser` (sessions included).
 *
 * WHY THIS FILE LIVES IN `runtime/`: same constraint as the other modules here —
 * the image only ships `runtime/` as a real directory, so this must stay free of
 * `@/` and `open-sse/` imports.
 *
 * WHAT STILL COMES FROM RAW (and why it is cheap):
 *   - `recentRequests`, `last10Minutes`, `recentCallDetails` — bounded recent
 *     windows (100 rows / 10 minutes / a page), not range scans.
 *   - traffic totals and `trafficSummary` — from `networkTraffic`, untouched by
 *     this split.
 * These are the same helpers the raw path uses, imported rather than copied, so
 * the two modes cannot drift.
 *
 * GRANULARITY CAVEAT: the rollup is keyed by LOCAL DAY, so a range is served at
 * day granularity — boundary days are included whole. That is the trade for not
 * scanning raw rows, and is why the board (calendar periods) uses this path while
 * the home page's rolling 24h/48h window stays on raw.
 */

import {
  buildRecentRequests,
  buildLast10Minutes,
  emptyStats,
  getRecentCallDetails,
  getTrafficRange,
  getTrafficSummary,
  getTrafficTotals,
} from "./usage-aggregate.mjs";
import { runRollupAggregation, readUserRollup, resolveDateKeyRange } from "./usage-rollup-read.mjs";

/** The periods/weekdays histograms live per person; summing them is the global one. */
function globalRhythm(byUser) {
  const periods = Array(6).fill(0);
  const weekdays = Array(7).fill(0);
  for (const person of Object.values(byUser || {})) {
    for (let i = 0; i < 6; i++) periods[i] += Number(person.periods?.[i]) || 0;
    for (let i = 0; i < 7; i++) weekdays[i] += Number(person.weekdays?.[i]) || 0;
  }
  return { periods, weekdays };
}

/**
 * Assemble the dashboard stats from the rollup table.
 *
 * @param {object} adapter  `{ all, get, iterate }` — same contract as runAggregation
 * @param {object} params   `{ period, range, connectionMap, apiKeyMap,
 *                            providerNodeNameMap, sourceCapture, now }`
 */
export function runRollupStats(adapter, {
  period = "all",
  range = {},
  connectionMap = {},
  apiKeyMap = {},
  providerNodeNameMap = {},
  sourceCapture = {},
  now = new Date(),
} = {}) {
  const aggregate = runRollupAggregation(adapter, {
    period, range, connectionMap, apiKeyMap, providerNodeNameMap, now,
  });

  const { from, to } = resolveDateKeyRange(period, range, now);
  const apiKeyIds = Array.isArray(range.apiKeyIds)
    ? range.apiKeyIds
    : (range.apiKeyId ? [range.apiKeyId] : null);
  const byUser = readUserRollup(adapter, { from, to, apiKeyMap, providerNodeNameMap, apiKeyIds });

  const stats = emptyStats(sourceCapture, buildRecentRequests(adapter, range, apiKeyMap));
  Object.assign(stats, aggregate, { byUser, source: "rollup" });

  stats.last10Minutes = buildLast10Minutes(adapter, range, now);
  // A bounded recent window, not a range scan — same helper the raw path uses.
  // Without this the board's 模型调用明细 stayed empty whenever the range was
  // served from the rollup (every day-aligned calendar range).
  stats.recentCallDetails = getRecentCallDetails(adapter, period, range, apiKeyMap, providerNodeNameMap);
  // The per-person histograms are the only source of the global rhythm, so sum
  // them once rather than per bucket.
  const rhythm = globalRhythm(byUser);
  stats.requestRhythm.periods.forEach((entry, index) => { entry.requests = rhythm.periods[index]; });
  stats.requestRhythm.weekdays.forEach((entry, index) => { entry.requests = rhythm.weekdays[index]; });

  const trafficTotals = getTrafficTotals(adapter, getTrafficRange(period, range));
  stats.totalRequestBytes = trafficTotals.requestBytes;
  stats.totalResponseBytes = trafficTotals.responseBytes;
  stats.totalTrafficBytes = trafficTotals.totalBytes;
  stats.trafficSummary = getTrafficSummary(adapter, { apiKeyId: range.apiKeyId || null, apiKeyIds: range.apiKeyIds || null });

  return stats;
}
