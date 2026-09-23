/**
 * Per-(user, day) accumulator for the personnel report.
 *
 * WHY THIS EXISTS — the generic rollup cannot serve `byUser`:
 *
 * `byUser` carries fields that are not sums over a dimension:
 *   - `sessionCount` / `activeSessionDurationMs` — a session is a run of a
 *     user's events no more than 30 minutes apart. This needs the ORDERED
 *     sequence of that user's events, which no counter can reconstruct.
 *   - four (user, X) crosses — `models`, `apps`, `sourceIps`, and the
 *     `periods[6]` / `weekdays[7]` histograms. The generic rollup's model/app/
 *     ip buckets carry no user, so they cannot be split back per person.
 *   - `completed/failed/cancelledRequests` per person (its status dimension is
 *     flat), and `requestDurationMs` / `durationRequestCount`.
 *
 * One row per (user, local day). Counters and the crosses are ordinary sums;
 * sessions are stored as the day's DISJOINT interval list, which is what makes
 * the whole thing mergeable.
 *
 * WHY DISJOINT INTERVALS ARE THE KEY:
 * An arriving event either lands in a gap between sessions (a new session) or
 * bridges a contiguous run of them (one merged session). That decision depends
 * only on the SET of intervals, never on arrival order — so the writer can
 * accumulate incrementally even though it sees events in COMPLETION order, not
 * start order (measured: 37.5% of recent rows arrive out of start order).
 * Verified against production: exact match on all 23 users.
 *
 * And because each day stores its full interval list rather than just first/last
 * bounds, a range read is a plain sort-and-merge over the union — a session that
 * spans midnight appears as two partial intervals (one per day) that rejoin at
 * read time, with no special-case correction.
 *
 * CONSTRAINTS: lives in `runtime/`, so no `@/` or `open-sse/` imports.
 */

import { statusBucket } from "./usage-rollup.mjs";
import { detectSourceApp } from "./usage-aggregate.mjs";

export const USER_ROLLUP_TABLE = "usageRollupUserDay";
export const SESSION_GAP_MS = 30 * 60 * 1000;

function localDateKey(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function parseJson(value, fallback = null) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "object") return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

function getRequestDurationMs(startedAt, completedAt) {
  const start = new Date(startedAt).getTime();
  const end = new Date(completedAt).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return 0;
  return end - start;
}

export function userRollupTableSql() {
  return `CREATE TABLE IF NOT EXISTS ${USER_ROLLUP_TABLE} (
    dateKey TEXT NOT NULL,
    apiKeyId TEXT NOT NULL,
    requests REAL DEFAULT 0,
    promptTokens REAL DEFAULT 0,
    completionTokens REAL DEFAULT 0,
    cachedTokens REAL DEFAULT 0,
    cost REAL DEFAULT 0,
    completedRequests REAL DEFAULT 0,
    failedRequests REAL DEFAULT 0,
    cancelledRequests REAL DEFAULT 0,
    requestDurationMs REAL DEFAULT 0,
    durationRequestCount REAL DEFAULT 0,
    firstUsed TEXT,
    lastUsed TEXT,
    models TEXT,
    apps TEXT,
    sourceIps TEXT,
    periods TEXT,
    weekdays TEXT,
    sessions TEXT,
    PRIMARY KEY (dateKey, apiKeyId)
  )`;
}

export function ensureUserRollupTable(database) {
  database.exec(userRollupTableSql());
}

// ─── session intervals ──────────────────────────────────────────────────────

/**
 * Sort and coalesce intervals that are within `gapMs` of each other.
 * The result is disjoint and ordered, and depends only on the input set.
 */
export function normalizeIntervals(intervals, gapMs = SESSION_GAP_MS) {
  const sorted = intervals
    .filter((iv) => Array.isArray(iv) && Number.isFinite(iv[0]) && Number.isFinite(iv[1]))
    .map((iv) => [iv[0], Math.max(iv[0], iv[1])])
    .sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const iv of sorted) {
    const last = out[out.length - 1];
    if (last && iv[0] <= last[1] + gapMs) last[1] = Math.max(last[1], iv[1]);
    else out.push([iv[0], iv[1]]);
  }
  return out;
}

/**
 * Add one event's interval to a disjoint interval list.
 *
 * Two steps, and both are needed: absorb every interval the event's gap-expanded
 * box touches (using the box from the ORIGINAL event, not a growing one), then
 * normalise — the merge can pull two previously-separate intervals together, and
 * only the normalise pass catches that chain.
 */
export function addSessionInterval(intervals, startMs, endMs, gapMs = SESSION_GAP_MS) {
  const start = Number(startMs);
  if (!Number.isFinite(start)) return normalizeIntervals(intervals, gapMs);
  const end = Math.max(start, Number(endMs) || start);
  const lo = start - gapMs;
  const hi = end + gapMs;

  let mergedStart = start;
  let mergedEnd = end;
  const kept = [];
  for (const iv of intervals) {
    if (Array.isArray(iv) && iv[1] >= lo && iv[0] <= hi) {
      mergedStart = Math.min(mergedStart, iv[0]);
      mergedEnd = Math.max(mergedEnd, iv[1]);
    } else {
      kept.push(iv);
    }
  }
  kept.push([mergedStart, mergedEnd]);
  return normalizeIntervals(kept, gapMs);
}

/** Session count and total duration for a disjoint interval list. */
export function sessionsFromIntervals(intervals, gapMs = SESSION_GAP_MS) {
  const merged = normalizeIntervals(intervals, gapMs);
  let durationMs = 0;
  for (const [start, end] of merged) durationMs += Math.max(0, end - start);
  return { count: merged.length, durationMs };
}

// ─── the per-event delta ────────────────────────────────────────────────────

function emptyCounterBucket() {
  return { requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0 };
}

function bumpCounter(map, key, values) {
  if (!key) return;
  const bucket = map[key] || (map[key] = emptyCounterBucket());
  bucket.requests += values.requests || 1;
  bucket.promptTokens += values.promptTokens || 0;
  bucket.completionTokens += values.completionTokens || 0;
  bucket.cachedTokens += values.cachedTokens || 0;
  bucket.cost += values.cost || 0;
}

/**
 * The per-(user, day) contribution of one usage event. Pure, so the merge rules
 * can be tested without a database.
 *
 * THE DAY IS THE START DAY, not the completion day. The raw path this must
 * match keys everything on `timestamp` (= `startedAt`): the range filter, the
 * `periods`/`weekdays` histograms, `firstUsed`/`lastUsed`, and `activeDays`
 * (via `getLocalDateKey(startedAt)`). Keying on `completedAt` would put a
 * request that starts at 23:50 and finishes at 00:05 in the wrong day and make
 * `activeDays` disagree. The flat rollup uses `completedAt`; this table
 * deliberately does not, because it exists to reproduce `byUser`.
 *
 * Model keys are stored RAW (`${model}|${provider}`) and resolved to the
 * `${model} (${providerName})` display form at read time — the writer has no
 * access to `providerNodeNameMap`, and baking a display name in would freeze it.
 */
export function userDayDelta(event) {
  const tokens = parseJson(event.tokens, {}) || {};
  const meta = parseJson(event.meta, {}) || {};
  const apiKeyId = event.apiKeyId || "local-no-key";

  const startedAt = event.startedAt || event.timestamp || event.completedAt;
  const completedAt = event.completedAt || startedAt;
  const timestamp = event.timestamp || startedAt;
  const dateKey = localDateKey(new Date(startedAt).getTime());

  const promptTokens = Number(event.promptTokens) || 0;
  const completionTokens = Number(event.completionTokens) || 0;
  const cachedTokens = Number(tokens.cached_tokens ?? tokens.cache_read_input_tokens) || 0;
  const cost = Number(event.cost) || 0;
  const provider = event.provider || null;
  const model = event.model || null;

  const models = {};
  // Keyed `${model}|${provider}` so the read side can resolve the display name.
  // A null provider stores the model alone (no pipe), matching the raw path's
  // `r.provider ? \`${r.model} (${provider})\` : r.model` — appending "unknown"
  // here would produce `model (unknown)` and a different bucket set.
  if (model) {
    bumpCounter(models, provider ? `${model}|${provider}` : model, { requests: 1, promptTokens, completionTokens, cachedTokens, cost });
  }

  const apps = {};
  bumpCounter(apps, detectSourceApp(meta), { requests: 1, promptTokens, completionTokens, cachedTokens, cost });

  const sourceIps = {};
  if (meta.sourceIp) bumpCounter(sourceIps, meta.sourceIp, { requests: 1, promptTokens, completionTokens, cachedTokens, cost });

  const periods = Array(6).fill(0);
  const weekdays = Array(7).fill(0);
  const requestedAt = new Date(timestamp);
  if (Number.isFinite(requestedAt.getTime())) {
    periods[Math.floor(requestedAt.getHours() / 4)] = 1;
    weekdays[(requestedAt.getDay() + 6) % 7] = 1;
  }

  const status = statusBucket(event.status);
  const durationMs = getRequestDurationMs(startedAt, completedAt);

  const startMs = new Date(startedAt).getTime();
  const endMs = new Date(completedAt).getTime();
  const sessions = Number.isFinite(startMs)
    ? [[startMs, Math.max(startMs, Number.isFinite(endMs) ? endMs : startMs)]]
    : [];

  return {
    dateKey,
    apiKeyId,
    counters: { requests: 1, promptTokens, completionTokens, cachedTokens, cost },
    status: { completed: status === "completed" ? 1 : 0, failed: status === "failed" ? 1 : 0, cancelled: status === "cancelled" ? 1 : 0 },
    requestDurationMs: durationMs,
    durationRequestCount: durationMs > 0 ? 1 : 0,
    firstUsed: timestamp,
    lastUsed: timestamp,
    models,
    apps,
    sourceIps,
    periods,
    weekdays,
    sessions,
  };
}

// ─── merge ──────────────────────────────────────────────────────────────────

function mergeCounterMaps(target, source) {
  const out = { ...(target || {}) };
  for (const [key, value] of Object.entries(source || {})) {
    const bucket = out[key] || (out[key] = emptyCounterBucket());
    bucket.requests += value.requests || 0;
    bucket.promptTokens += value.promptTokens || 0;
    bucket.completionTokens += value.completionTokens || 0;
    bucket.cachedTokens += value.cachedTokens || 0;
    bucket.cost += value.cost || 0;
  }
  return out;
}

function addArrays(target, source, length) {
  const out = Array.from({ length }, (_, i) => Number(target?.[i]) || 0);
  for (let i = 0; i < length; i++) out[i] += Number(source?.[i]) || 0;
  return out;
}

function earlier(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  return a < b ? a : b;
}

function later(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  return a > b ? a : b;
}

/** Fold a delta into a stored row (or a fresh one). Pure. */
export function mergeUserDay(existing, delta) {
  const base = existing || {};
  const incoming = delta.sessions?.[0];
  const sessions = incoming
    ? addSessionInterval(parseIntervals(base.sessions), incoming[0], incoming[1])
    : parseIntervals(base.sessions);
  return {
    dateKey: delta.dateKey,
    apiKeyId: delta.apiKeyId,
    requests: (base.requests || 0) + delta.counters.requests,
    promptTokens: (base.promptTokens || 0) + delta.counters.promptTokens,
    completionTokens: (base.completionTokens || 0) + delta.counters.completionTokens,
    cachedTokens: (base.cachedTokens || 0) + delta.counters.cachedTokens,
    cost: (base.cost || 0) + delta.counters.cost,
    completedRequests: (base.completedRequests || 0) + delta.status.completed,
    failedRequests: (base.failedRequests || 0) + delta.status.failed,
    cancelledRequests: (base.cancelledRequests || 0) + delta.status.cancelled,
    requestDurationMs: (base.requestDurationMs || 0) + delta.requestDurationMs,
    durationRequestCount: (base.durationRequestCount || 0) + delta.durationRequestCount,
    firstUsed: earlier(base.firstUsed, delta.firstUsed),
    lastUsed: later(base.lastUsed, delta.lastUsed),
    models: mergeCounterMaps(base.models, delta.models),
    apps: mergeCounterMaps(base.apps, delta.apps),
    sourceIps: mergeCounterMaps(base.sourceIps, delta.sourceIps),
    periods: addArrays(base.periods, delta.periods, 6),
    weekdays: addArrays(base.weekdays, delta.weekdays, 7),
    sessions,
  };
}

function parseIntervals(value) {
  const parsed = parseJson(value, []) || [];
  return Array.isArray(parsed) ? parsed : [];
}

// ─── write ──────────────────────────────────────────────────────────────────

/**
 * Apply one event to the (user, day) accumulator. Runs inside the caller's
 * transaction. Read-modify-write because sessions and the crosses are not
 * expressible as SQL increments.
 */
export function applyEventToUserRollup(database, event) {
  const delta = userDayDelta(event);
  const existing = database.prepare(
    `SELECT * FROM ${USER_ROLLUP_TABLE} WHERE dateKey = ? AND apiKeyId = ?`,
  ).get(delta.dateKey, delta.apiKeyId);

  const row = mergeUserDay(existing ? deserializeRow(existing) : null, delta);
  const serialized = serializeRow(row);

  database.prepare(
    `INSERT INTO ${USER_ROLLUP_TABLE}(
       dateKey, apiKeyId, requests, promptTokens, completionTokens, cachedTokens, cost,
       completedRequests, failedRequests, cancelledRequests, requestDurationMs, durationRequestCount,
       firstUsed, lastUsed, models, apps, sourceIps, periods, weekdays, sessions
     ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(dateKey, apiKeyId) DO UPDATE SET
       requests = excluded.requests, promptTokens = excluded.promptTokens,
       completionTokens = excluded.completionTokens, cachedTokens = excluded.cachedTokens,
       cost = excluded.cost, completedRequests = excluded.completedRequests,
       failedRequests = excluded.failedRequests, cancelledRequests = excluded.cancelledRequests,
       requestDurationMs = excluded.requestDurationMs, durationRequestCount = excluded.durationRequestCount,
       firstUsed = excluded.firstUsed, lastUsed = excluded.lastUsed,
       models = excluded.models, apps = excluded.apps, sourceIps = excluded.sourceIps,
       periods = excluded.periods, weekdays = excluded.weekdays, sessions = excluded.sessions`,
  ).run(...serialized);
}

/** JSON-encode the nested columns of a row for storage. */
export function serializeRow(row) {
  return [
    row.dateKey, row.apiKeyId, row.requests, row.promptTokens, row.completionTokens, row.cachedTokens, row.cost,
    row.completedRequests, row.failedRequests, row.cancelledRequests, row.requestDurationMs, row.durationRequestCount,
    row.firstUsed, row.lastUsed,
    JSON.stringify(row.models || {}), JSON.stringify(row.apps || {}), JSON.stringify(row.sourceIps || {}),
    JSON.stringify(row.periods || []), JSON.stringify(row.weekdays || []), JSON.stringify(row.sessions || []),
  ];
}

/** Decode a stored row's nested JSON columns. */
export function deserializeRow(row) {
  return {
    ...row,
    models: parseJson(row.models, {}) || {},
    apps: parseJson(row.apps, {}) || {},
    sourceIps: parseJson(row.sourceIps, {}) || {},
    periods: parseJson(row.periods, []) || [],
    weekdays: parseJson(row.weekdays, []) || [],
    sessions: parseJson(row.sessions, []) || [],
  };
}

// ─── read ───────────────────────────────────────────────────────────────────

/**
 * Person display name and mask, mirroring the raw aggregation's `byUser` branch
 * exactly (usage-aggregate.mjs) — the board renders these strings, so a
 * different wording here would show up as a label change.
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
 * Aggregate `usageRollupUserDay` over a date range into the `byUser` map shape
 * the raw aggregation produces.
 *
 * `activeDays` counts the distinct days on which the user had a request — read
 * straight off the per-day rows rather than a stored field.
 *
 * @param {object} adapter  `{ all(sql, params) }`
 * @param {object} params   `{ from, to, apiKeyMap, providerNodeNameMap }`
 */
export function readUserRollup(adapter, {
  from = null,
  to = null,
  apiKeyMap = {},
  providerNodeNameMap = {},
} = {}) {
  const conditions = [];
  const params = [];
  if (from) { conditions.push("dateKey >= ?"); params.push(from); }
  if (to) { conditions.push("dateKey <= ?"); params.push(to); }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  const rows = adapter.all(`SELECT * FROM ${USER_ROLLUP_TABLE} ${where}`, params);
  const byUser = {};
  const sessionsByUser = new Map();

  for (const raw of rows) {
    const row = deserializeRow(raw);
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
    person.firstUsed = earlier(person.firstUsed, row.firstUsed);
    person.lastUsed = later(person.lastUsed, row.lastUsed);
    if ((row.requests || 0) > 0) person.activeDays += 1;

    person.models = mergeCounterMaps(person.models, remapModelKeys(row.models, providerNodeNameMap));
    person.apps = mergeCounterMaps(person.apps, row.apps);
    person.sourceIps = mergeCounterMaps(person.sourceIps, row.sourceIps);
    person.periods = addArrays(person.periods, row.periods, 6);
    person.weekdays = addArrays(person.weekdays, row.weekdays, 7);

    const collected = sessionsByUser.get(key) || [];
    for (const iv of row.sessions) collected.push(iv);
    sessionsByUser.set(key, collected);
  }

  for (const [key, intervals] of sessionsByUser) {
    const { count, durationMs } = sessionsFromIntervals(intervals);
    byUser[key].sessionCount = count;
    byUser[key].activeSessionDurationMs = durationMs;
  }

  return byUser;
}

/** `${model}|${provider}` → the `${model} (${providerName})` display key. */
function remapModelKeys(models, providerNodeNameMap) {
  const out = {};
  for (const [key, value] of Object.entries(models || {})) {
    const idx = String(key).indexOf("|");
    if (idx < 0) { out[key] = value; continue; }
    const model = String(key).slice(0, idx);
    const provider = String(key).slice(idx + 1);
    out[`${model} (${providerNodeNameMap[provider] || provider})`] = value;
  }
  return out;
}
