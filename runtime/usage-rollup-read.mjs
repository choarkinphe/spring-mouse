/**
 * Read-side of the daily usage rollup.
 *
 * Produces a stats object shaped like `runAggregation`'s, but assembled from
 * `usageRollup` instead of scanning `usageHistory`. A 30-day window reads ~16k
 * bucket rows instead of ~880k raw rows.
 *
 * WHAT IT DOES NOT PRODUCE (by design — see the split plan):
 *   - `byUser` and everything the personnel report needs. `byUser` carries
 *     session metrics that cannot be reconstructed from counters (the writer
 *     sees events in completion order, not time order — measured 37.5% out of
 *     order), plus four (user, X) cross dimensions. Those stay on the raw path.
 *   - Live fields (`activeRequests`, `recentRequests`, `pending`,
 *     `errorIndicator`, `last10Minutes`). Those come from the in-process ring
 *     and Redis, and the caller overlays them exactly as it does today.
 *   - Traffic totals (`totalRequestBytes` etc.), which come from
 *     `networkTraffic` and are unaffected by this split.
 *
 * CALLERS MUST NOT read `byUser` off this result. The caller is expected to
 * merge: rollup for the aggregate dimensions, raw for the person report.
 *
 * CONSTRAINTS (same as the other `runtime/` modules): no `@/` or `open-sse/`
 * alias imports — this directory is the only one shipped as real files.
 */

import { ROLLUP_TABLE, COUNTER_COLUMNS } from "./usage-rollup.mjs";

/**
 * Dimensions this module can serve. `user` is deliberately absent: the board's
 * person ranking needs session metrics, which live on the raw path.
 */
export const ROLLUP_READ_DIMENSIONS = [
  "provider",
  "model",
  "account",
  "apiKey",
  "endpoint",
  "sourceIp",
  "app",
];

function parseJson(value, fallback = null) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "object") return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

/** Local-date key for a Date, matching how the writer keys `dateKey`. */
export function localDateKey(date) {
  const d = new Date(date);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const PERIOD_DAYS = { "7d": 7, "30d": 30, "60d": 60 };

/**
 * Turn a period/range into an inclusive `[fromDateKey, toDateKey]` pair of local
 * date strings, or nulls for "no bound".
 *
 * The rollup is keyed by LOCAL day, so the range must be expressed in local days
 * too. A rolling window (e.g. "last 7 days") cannot be represented exactly at
 * day granularity — the boundary day is included whole. That is acceptable for a
 * daily view, and is the trade for not scanning raw rows.
 */
export function resolveDateKeyRange(period, range = {}, now = new Date()) {
  if (range.startDate && range.endDate) {
    return { from: localDateKey(range.startDate), to: localDateKey(range.endDate) };
  }
  if (period === "today") return { from: localDateKey(now), to: localDateKey(now) };
  const days = PERIOD_DAYS[period];
  if (days) {
    const from = new Date(now.getTime() - days * 86400_000);
    return { from: localDateKey(from), to: localDateKey(now) };
  }
  // "24h"/"48h" and anything else: no exact day-granular equivalent, so leave it
  // unbounded and let the caller decide (the home page stays on the raw path).
  return { from: null, to: null };
}

function emptyCounters() {
  const c = {};
  for (const col of COUNTER_COLUMNS) c[col] = 0;
  return c;
}

function addCounters(target, row) {
  for (const col of COUNTER_COLUMNS) target[col] += Number(row[col]) || 0;
}

/**
 * Aggregate `usageRollup` into the stats shape the board consumes.
 *
 * @param {object} adapter  `{ all(sql, params) }` — same adapter contract as runAggregation
 * @param {object} params   `{ period, range, connectionMap, apiKeyMap, providerNodeNameMap, now }`
 */
export function runRollupAggregation(adapter, {
  period = "all",
  range = {},
  connectionMap = {},
  apiKeyMap = {},
  providerNodeNameMap = {},
  now = new Date(),
} = {}) {
  const { from, to } = resolveDateKeyRange(period, range, now);
  const conditions = [];
  const params = [];
  if (from) { conditions.push("dateKey >= ?"); params.push(from); }
  if (to) { conditions.push("dateKey <= ?"); params.push(to); }
  // apiKey scoping: the rollup stores the raw apiKeyId in apiKey/user bucket
  // keys, so scope by matching the apiKey dimension's key prefix.
  const scopedApiKeyIds = Array.isArray(range.apiKeyIds) ? range.apiKeyIds : null;
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  const rows = adapter.all(
    `SELECT dateKey, dimension, bucketKey, ${COUNTER_COLUMNS.join(", ")}, meta
       FROM ${ROLLUP_TABLE} ${where}`,
    params,
  );

  const stats = {
    totalRequests: 0,
    completedRequests: 0,
    failedRequests: 0,
    cancelledRequests: 0,
    meteredRequests: 0,
    totalPromptTokens: 0,
    totalCompletionTokens: 0,
    totalCachedTokens: 0,
    totalCost: 0,
    byProvider: {},
    byModel: {},
    byAccount: {},
    byApiKey: {},
    byEndpoint: {},
    bySourceIp: {},
    byApp: {},
    // Not produced here; the caller merges the raw path's value.
    byUser: {},
    source: "rollup",
  };

  // Provider bucket keys may be scoped-filtered below; collect for the scope check.
  const allowedApiKeyIds = scopedApiKeyIds ? new Set(scopedApiKeyIds) : null;

  for (const row of rows) {
    const meta = parseJson(row.meta, {}) || {};
    const dim = row.dimension;

    // Status counts are a flat dimension: bucketKey is the normalised bucket.
    if (dim === "status") {
      const n = Number(row.requests) || 0;
      if (row.bucketKey === "completed") stats.completedRequests += n;
      else if (row.bucketKey === "failed") stats.failedRequests += n;
      else if (row.bucketKey === "cancelled") stats.cancelledRequests += n;
      continue;
    }

    // apiKey-scoped dashboards: only the dimensions whose key carries the
    // apiKeyId can be filtered meaningfully.
    if (allowedApiKeyIds) {
      const keyApiKey = dim === "apiKey" || dim === "user" ? String(row.bucketKey).split("|")[0] : null;
      if (keyApiKey && !allowedApiKeyIds.has(keyApiKey)) continue;
    }

    const counters = emptyCounters();
    addCounters(counters, row);

    switch (dim) {
      case "provider": {
        const key = row.bucketKey;
        const b = stats.byProvider[key] || (stats.byProvider[key] = emptyCounters());
        addCounters(b, row);
        break;
      }
      case "model": {
        // Stored as `${model}|${provider}`; the raw path keys `${model} (${provider})`.
        const [rawModel, provider] = splitModelKey(row.bucketKey);
        const key = provider ? `${rawModel} (${provider})` : rawModel;
        const b = stats.byModel[key] || (stats.byModel[key] = {
          ...emptyCounters(), rawModel, provider: providerNodeNameMap[provider] || provider || null, lastUsed: null,
        });
        addCounters(b, row);
        if (!b.lastUsed || row.dateKey > b.lastUsed) b.lastUsed = row.dateKey;
        break;
      }
      case "account": {
        const [connectionId, rawModel, provider] = splitAccountKey(row.bucketKey);
        const accountName = connectionMap[connectionId] || (connectionId ? `Account ${connectionId.slice(0, 8)}...` : null);
        const key = `${rawModel} (${provider} - ${accountName})`;
        const b = stats.byAccount[key] || (stats.byAccount[key] = {
          ...emptyCounters(), rawModel, provider: providerNodeNameMap[provider] || provider || null,
          connectionId, accountName, lastUsed: null,
        });
        addCounters(b, row);
        if (!b.lastUsed || row.dateKey > b.lastUsed) b.lastUsed = row.dateKey;
        break;
      }
      case "apiKey": {
        const [apiKeyId, rawModel, provider] = splitAccountKey(row.bucketKey);
        const keyInfo = apiKeyMap[apiKeyId];
        const keyName = keyInfo?.name
          || (String(apiKeyId).startsWith("external:") ? "External API Key" : apiKeyId === "local-no-key" ? "Local (No API Key)" : "Deleted API Key");
        const apiKeyMasked = keyInfo ? null : (String(apiKeyId).startsWith("external:") ? "External API Key" : null);
        const key = row.bucketKey;
        const b = stats.byApiKey[key] || (stats.byApiKey[key] = {
          ...emptyCounters(), rawModel, provider: providerNodeNameMap[provider] || provider || null,
          apiKeyMasked, keyName, apiKeyKey: apiKeyId, lastUsed: null,
        });
        addCounters(b, row);
        if (!b.lastUsed || row.dateKey > b.lastUsed) b.lastUsed = row.dateKey;
        break;
      }
      case "endpoint": {
        const [endpoint, rawModel, provider] = splitAccountKey(row.bucketKey);
        const key = row.bucketKey;
        const b = stats.byEndpoint[key] || (stats.byEndpoint[key] = {
          ...emptyCounters(), endpoint, rawModel, provider: providerNodeNameMap[provider] || provider || null, lastUsed: null,
        });
        addCounters(b, row);
        if (!b.lastUsed || row.dateKey > b.lastUsed) b.lastUsed = row.dateKey;
        break;
      }
      case "sourceIp": {
        const key = row.bucketKey;
        const b = stats.bySourceIp[key] || (stats.bySourceIp[key] = {
          ...emptyCounters(), sourceIp: key, sourceGeo: null, lastUsed: null,
        });
        addCounters(b, row);
        if (!b.lastUsed || row.dateKey > b.lastUsed) b.lastUsed = row.dateKey;
        break;
      }
      case "app": {
        const key = row.bucketKey;
        const b = stats.byApp[key] || (stats.byApp[key] = {
          ...emptyCounters(), appName: key, lastUsed: null,
        });
        addCounters(b, row);
        if (!b.lastUsed || row.dateKey > b.lastUsed) b.lastUsed = row.dateKey;
        break;
      }
      default:
        break;
    }
  }

  // totalRequests counts events, so it must come from a single dimension —
  // summing every dimension would multiply by the number of buckets per event.
  stats.totalRequests = Object.values(stats.byProvider).reduce((sum, b) => sum + (b.requests || 0), 0);
  // The token/cost totals are the same sums over the same single dimension.
  // Computed here rather than per-row so they cannot be inflated by the
  // multi-bucket-per-event problem above.
  stats.totalPromptTokens = Object.values(stats.byProvider).reduce((sum, b) => sum + (b.promptTokens || 0), 0);
  stats.totalCompletionTokens = Object.values(stats.byProvider).reduce((sum, b) => sum + (b.completionTokens || 0), 0);
  stats.totalCachedTokens = Object.values(stats.byProvider).reduce((sum, b) => sum + (b.cachedTokens || 0), 0);
  stats.totalCost = Object.values(stats.byProvider).reduce((sum, b) => sum + (b.cost || 0), 0);
  // meteredRequests is not derivable from counters (it needs per-row token>0);
  // the caller overlays it or leaves it out of rollup-backed views.
  stats.meteredRequests = stats.totalRequests;

  return stats;
}

function splitModelKey(bucketKey) {
  const idx = String(bucketKey).indexOf("|");
  if (idx < 0) return [String(bucketKey), null];
  return [String(bucketKey).slice(0, idx), String(bucketKey).slice(idx + 1) || null];
}

function splitAccountKey(bucketKey) {
  const parts = String(bucketKey).split("|");
  return [parts[0] || null, parts[1] || null, parts[2] || null];
}
