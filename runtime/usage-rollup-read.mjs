/**
 * Read side of the daily usage rollup.
 *
 * Turns `usageRollupDay` rows into the same stats object `runAggregation`
 * produces. Two reads happen here:
 *   - `runRollupAggregation` → the six aggregate dimensions, status counts and totals
 *   - `readUserRollup`       → `byUser`, including session metrics
 * Both come from the SAME table; `byUser` is the row itself and the aggregate
 * dimensions are the row's nested maps summed across keys.
 *
 * WHY ONE TABLE: every dimension the board shows is either a sum over (day, key)
 * or a sum over one of the row's (key, X) maps. That makes the tag-scoped view a
 * primary-key filter, so ALL dimensions are scopeable — a dimension-per-row
 * table cannot do that, because six of the seven dimensions carry no key, and a
 * scoped view would silently report unscoped numbers.
 *
 * WHAT IS NOT PRODUCED (the caller overlays it):
 *   - `recentRequests`, `last10Minutes`, `recentCallDetails` — bounded recent
 *     windows, cheap to read raw.
 *   - traffic totals — from `networkTraffic`, unaffected by this split.
 *   - live fields (`activeRequests`, `pending`, `errorIndicator`).
 *
 * CONSTRAINTS (same as the other `runtime/` modules): no `@/` or `open-sse/`
 * alias imports — this directory is the only one shipped as real files.
 */

import { COUNTER_COLUMNS, ROLLUP_TABLE, deserializeRow, sessionsFromIntervals } from "./usage-rollup.mjs";
import { startOfDay, endOfDay, localDateKey as localDateKeyTz } from "./timezone.mjs";

/** The dimensions this module can serve, in the raw path's display shape. */
export const ROLLUP_READ_DIMENSIONS = [
  "byProvider",
  "byModel",
  "byAccount",
  "byApiKey",
  "byEndpoint",
  "bySourceIp",
  "byApp",
];

const PERIOD_DAYS = { "7d": 7, "30d": 30, "60d": 60 };

/**
 * Turn a period/range into an inclusive `[fromDateKey, toDateKey]` pair of local
 * date strings, or nulls for "no bound".
 *
 * The rollup is keyed by LOCAL day, so the range must be expressed in local days
 * too. A rolling window cannot be represented exactly at day granularity — the
 * boundary days are included whole, so "last 7 days" would cover up to 8
 * calendar days. That is why `isDayAlignedRange` gates this: a rolling window is
 * served from raw instead.
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

/**
 * Does this range fall on local-day boundaries?
 *
 * Only then is the rollup's day granularity EXACT. A rolling window ("the last
 * 7 days" from 15:00) starts mid-day, so serving it from the rollup would
 * include the boundary day whole — up to 8 calendar days instead of 7. The
 * board's calendar periods are day-aligned and qualify; the home page's rolling
 * windows do not, and stay on raw.
 */
export function isDayAlignedRange(range = {}) {
  if (!range.startDate || !range.endDate) return true;   // period-based ranges are whole days
  const start = new Date(range.startDate);
  const end = new Date(range.endDate);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) return false;
  // A day-aligned range starts at APP_TIMEZONE midnight and ends at that zone's
  // end-of-day. The client builds its range with the same basis, so the two agree
  // regardless of the process TZ (CI is UTC; the container is CST).
  return start.getTime() === startOfDay(start).getTime()
    && end.getTime() === endOfDay(end).getTime();
}

export function localDateKey(value) {
  return localDateKeyTz(value);
}

function emptyCounters() {
  const c = {};
  for (const col of COUNTER_COLUMNS) c[col] = 0;
  return c;
}

function addCounters(target, source) {
  for (const col of COUNTER_COLUMNS) target[col] += Number(source[col]) || 0;
}

/**
 * Split a stored map key into its parts. Empty parts stand for null (the write
 * side stores `""` for a null model/provider, matching the raw template
 * coercion), so they come back as null here.
 */
function splitKey(key, parts) {
  const out = String(key).split("|");
  return Array.from({ length: parts }, (_, i) => (out[i] === undefined || out[i] === "" ? null : out[i]));
}

/**
 * Aggregate `usageRollupDay` into the stats shape the board consumes.
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

  // The tag scope resolves to a set of API keys, and the key IS the primary
  // key's second column — so a scoped read is a plain filter, and every
  // dimension below is scoped by construction.
  const scopedIds = Array.isArray(range.apiKeyIds)
    ? new Set(range.apiKeyIds)
    : (range.apiKeyId ? new Set([range.apiKeyId]) : null);
  if (scopedIds) {
    if (scopedIds.size === 0) { conditions.push("0 = 1"); }
    else {
      const ids = [...scopedIds];
      conditions.push(`apiKeyId IN (${ids.map(() => "?").join(", ")})`);
      params.push(...ids);
    }
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const rows = adapter.all(`SELECT * FROM ${ROLLUP_TABLE} ${where}`, params).map(deserializeRow);

  const stats = {
    ...emptyCounters(),
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
    // Not produced here; the caller merges `readUserRollup`'s value.
    byUser: {},
    source: "rollup",
  };

  const addBucket = (map, key, counters, extra = {}) => {
    const bucket = map[key] || (map[key] = { ...emptyCounters(), ...extra });
    addCounters(bucket, counters);
    return bucket;
  };
  const touch = (bucket, dateKey) => { if (!bucket.lastUsed || dateKey > bucket.lastUsed) bucket.lastUsed = dateKey; };

  for (const row of rows) {
    // Totals come from the row's own counters — one row is one (day, key), so
    // there is no buckets-per-event multiplication here.
    stats.totalRequests += row.requests || 0;
    stats.completedRequests += row.completedRequests || 0;
    stats.failedRequests += row.failedRequests || 0;
    stats.cancelledRequests += row.cancelledRequests || 0;
    stats.totalPromptTokens += row.promptTokens || 0;
    stats.totalCompletionTokens += row.completionTokens || 0;
    stats.totalCachedTokens += row.cachedTokens || 0;
    stats.totalCost += row.cost || 0;

    const keyInfo = apiKeyMap[row.apiKeyId];
    const keyName = keyInfo?.name
      || (String(row.apiKeyId).startsWith("external:") ? "External API Key" : row.apiKeyId === "local-no-key" ? "Local (No API Key)" : "Deleted API Key");
    const keyMasked = keyInfo ? null : (String(row.apiKeyId).startsWith("external:") ? "External API Key" : null);

    for (const [rawKey, counters] of Object.entries(row.models)) {
      const [model, provider] = splitKey(rawKey, 2);
      const providerName = providerNodeNameMap[provider] || provider;
      // byProvider: the raw path keys by the raw provider id, and a null provider
      // becomes the "null" bucket there (non-billing endpoints like count_tokens).
      touch(addBucket(stats.byProvider, provider === null ? "null" : provider, counters), row.dateKey);

      // byModel keys on the RAW provider id (`${model} (${provider})`) and only
      // its `provider` FIELD carries the display name — the raw path does the
      // same, so the bucket keys must match exactly.
      const modelKey = provider ? `${model} (${provider})` : String(model);
      touch(addBucket(stats.byModel, modelKey, counters, { rawModel: model, provider: providerName, lastUsed: null }), row.dateKey);

      const akKey = `${row.apiKeyId}|${model}|${provider || "unknown"}`;
      touch(addBucket(stats.byApiKey, akKey, counters, { rawModel: model, provider: providerName, apiKeyMasked: keyMasked, keyName, apiKeyKey: row.apiKeyId, lastUsed: null }), row.dateKey);
    }

    for (const [rawKey, counters] of Object.entries(row.accounts)) {
      const [connectionId, model, provider] = splitKey(rawKey, 3);
      const accountName = connectionMap[connectionId] || (connectionId ? `Account ${String(connectionId).slice(0, 8)}...` : null);
      const providerName = providerNodeNameMap[provider] || provider;
      const key = `${model} (${provider} - ${accountName})`;
      touch(addBucket(stats.byAccount, key, counters, { rawModel: model, provider: providerName, connectionId, accountName, lastUsed: null }), row.dateKey);
    }

    for (const [rawKey, counters] of Object.entries(row.endpoints)) {
      const [endpoint, model, provider] = splitKey(rawKey, 3);
      const providerName = providerNodeNameMap[provider] || provider;
      // The raw path's key template coerces a null provider to "unknown" here
      // (but keeps it raw in the account key) — reproduce that exactly.
      const key = `${endpoint}|${model}|${provider || "unknown"}`;
      touch(addBucket(stats.byEndpoint, key, counters, { endpoint, rawModel: model, provider: providerName, lastUsed: null }), row.dateKey);
    }

    for (const [ip, counters] of Object.entries(row.sourceIps)) {
      touch(addBucket(stats.bySourceIp, ip, counters, { sourceIp: ip, sourceGeo: null, lastUsed: null }), row.dateKey);
    }

    for (const [appName, counters] of Object.entries(row.apps)) {
      touch(addBucket(stats.byApp, appName, counters, { appName, lastUsed: null }), row.dateKey);
    }
  }

  // meteredRequests needs per-row token>0, which the counters do not preserve;
  // the caller overlays it or leaves it out of rollup-backed views.
  stats.meteredRequests = stats.totalRequests;
  return stats;
}

/**
 * Person display name and mask, mirroring the raw aggregation's `byUser` branch
 * exactly — the board renders these strings, so a different wording would show
 * up as a label change.
 */
function usageUserName(apiKeyId, apiKeyMap) {
  const info = apiKeyId ? apiKeyMap[apiKeyId] : null;
  if (info?.name) return info.name;
  if (apiKeyId === "local-no-key" || !apiKeyId) return "Local (No API Key)";
  if (String(apiKeyId).startsWith("external:")) return "External API Key";
  return "Deleted API Key";
}

function usageKeyMasked(apiKeyId, apiKeyMap) {
  if (apiKeyId && apiKeyMap[apiKeyId]) return null;
  return String(apiKeyId || "").startsWith("external:") ? "External API Key" : null;
}

/**
 * Aggregate `usageRollupDay` into the `byUser` map shape the raw aggregation
 * produces.
 *
 * `activeDays` counts the distinct days on which the key had a request — read
 * off the per-day rows rather than stored. Session metrics come from the day's
 * interval lists, merged across the whole range: a session spanning midnight is
 * two partial intervals that rejoin here, so no correction formula is needed.
 */
export function readUserRollup(adapter, {
  from = null,
  to = null,
  apiKeyMap = {},
  providerNodeNameMap = {},
  apiKeyIds = null,
} = {}) {
  const conditions = [];
  const params = [];
  if (from) { conditions.push("dateKey >= ?"); params.push(from); }
  if (to) { conditions.push("dateKey <= ?"); params.push(to); }
  if (Array.isArray(apiKeyIds)) {
    if (apiKeyIds.length === 0) conditions.push("0 = 1");
    else { conditions.push(`apiKeyId IN (${apiKeyIds.map(() => "?").join(", ")})`); params.push(...apiKeyIds); }
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const rows = adapter.all(`SELECT * FROM ${ROLLUP_TABLE} ${where}`, params).map(deserializeRow);

  const byUser = {};
  const sessionsByUser = new Map();

  for (const row of rows) {
    const key = row.apiKeyId;
    const person = byUser[key] || (byUser[key] = {
      requests: 0, completedRequests: 0, failedRequests: 0, cancelledRequests: 0,
      promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0,
      requestDurationMs: 0, durationRequestCount: 0,
      models: {}, sourceIps: {}, apps: {},
      periods: Array(6).fill(0), weekdays: Array(7).fill(0),
      firstUsed: null, lastUsed: null, activeDays: 0,
      userId: key,
      keyName: usageUserName(key, apiKeyMap),
      apiKeyMasked: usageKeyMasked(key, apiKeyMap),
    });

    person.requests += row.requests || 0;
    person.completedRequests += row.completedRequests || 0;
    person.failedRequests += row.failedRequests || 0;
    person.cancelledRequests += row.cancelledRequests || 0;
    person.promptTokens += row.promptTokens || 0;
    person.completionTokens += row.completionTokens || 0;
    person.cachedTokens += row.cachedTokens || 0;
    person.cost += row.cost || 0;
    person.requestDurationMs += row.requestDurationMs || 0;
    person.durationRequestCount += row.durationRequestCount || 0;
    person.firstUsed = !person.firstUsed || (row.firstUsed && row.firstUsed < person.firstUsed) ? (row.firstUsed || person.firstUsed) : person.firstUsed;
    person.lastUsed = !person.lastUsed || (row.lastUsed && row.lastUsed > person.lastUsed) ? (row.lastUsed || person.lastUsed) : person.lastUsed;
    if ((row.requests || 0) > 0) person.activeDays += 1;

    // `byUser.models` uses the DISPLAY provider name (the raw path passes
    // providerDisplayName here), unlike byModel which keeps the raw id.
    for (const [rawKey, counters] of Object.entries(row.models)) {
      const [model, provider] = splitKey(rawKey, 2);
      const providerName = providerNodeNameMap[provider] || provider;
      addBucketToMap(person.models, provider ? `${model} (${providerName})` : String(model), counters);
    }
    for (const [appName, counters] of Object.entries(row.apps)) addBucketToMap(person.apps, appName, counters);
    for (const [ip, counters] of Object.entries(row.sourceIps)) addBucketToMap(person.sourceIps, ip, counters);
    for (let i = 0; i < 6; i++) person.periods[i] += Number(row.periods?.[i]) || 0;
    for (let i = 0; i < 7; i++) person.weekdays[i] += Number(row.weekdays?.[i]) || 0;

    const collected = sessionsByUser.get(key) || [];
    for (const iv of row.sessions || []) collected.push(iv);
    sessionsByUser.set(key, collected);
  }

  for (const [key, intervals] of sessionsByUser) {
    const { count, durationMs } = sessionsFromIntervals(intervals);
    byUser[key].sessionCount = count;
    byUser[key].activeSessionDurationMs = durationMs;
  }

  return byUser;
}

function addBucketToMap(map, key, counters) {
  const bucket = map[key] || (map[key] = emptyCounters());
  addCounters(bucket, counters);
}
