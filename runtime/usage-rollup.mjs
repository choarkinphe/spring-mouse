/**
 * Daily usage rollup — ONE table, keyed by (local day, API key).
 *
 * WHY ONE TABLE AND NOT A TABLE PER DIMENSION:
 * Every question the dashboard asks is either a sum over (day, key) or a sum
 * over one of the nested maps stored on that row. Keeping the maps on the row
 * (`models`, `apps`, `sourceIps`, `accounts`, `endpoints`) means:
 *   - `byUser` is the row itself, with its session intervals and histograms;
 *   - `byModel` / `byProvider` / `byApp` / `bySourceIp` / `byAccount` /
 *     `byEndpoint` are derived by summing the maps across keys;
 *   - a tag-scoped dashboard filters on the primary key, so EVERY dimension is
 *     scopeable. (A dimension-per-row table cannot do this: six of the seven
 *     dimensions carry no key, so a scoped view would silently report unscoped
 *     numbers — 91.8% of production traffic is in the default scope.)
 * Measured on production: 454 rows for 37 days of 550k events, and all seven
 * dimensions plus `byUser` derive from it exactly.
 *
 * GRANULARITY: local DAY, keyed on `timestamp` (= startedAt) — the same basis
 * the raw aggregation filters and buckets on, so `activeDays`, the histograms
 * and the range filter agree with it. A range is served at day granularity, so
 * boundary days are included whole; that is the trade for not scanning raw rows.
 *
 * WHY SESSIONS ARE STORED AS DISJOINT INTERVALS:
 * A session is a run of a key's events no more than 30 minutes apart — not a sum
 * over anything, so it cannot be a counter. Storing the day's interval list (not
 * just first/last bounds) makes the value order-independent: an arriving event
 * either lands in a gap or bridges a contiguous run of sessions, which depends
 * only on the interval SET. That is what lets the writer accumulate as events
 * arrive in COMPLETION order (measured: 37.5% arrive out of start order), and it
 * makes a range read a plain sort-and-merge — a session spanning midnight is two
 * partial intervals that rejoin, with no correction formula.
 *
 * CONSTRAINTS: lives in `runtime/`, which is the only directory shipped as real
 * files in the image, so it must stay free of `@/` and `open-sse/` imports.
 */

import { detectSourceApp } from "./usage-aggregate.mjs";
import { startOfDay, localDateKey as localDateKeyTz } from "./timezone.mjs";

export const ROLLUP_TABLE = "usageRollupDay";
export const SESSION_GAP_MS = 30 * 60 * 1000;

/** Counter columns, mirroring the raw aggregation's bucket shape. */
export const COUNTER_COLUMNS = ["requests", "promptTokens", "completionTokens", "cachedTokens", "cost"];

/** The nested (key, X) maps stored per row. */
export const MAP_COLUMNS = ["models", "apps", "sourceIps", "accounts", "endpoints"];

export function localDateKey(value) {
  return localDateKeyTz(value);
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

/**
 * Map a raw status onto the bucket the board counts.
 *
 * EXACT match, mirroring the raw aggregation: only `cancelled` and `error` are
 * special, everything else counts as completed. So `blocked:account_locked` and
 * `upstream:503` land in completed, which looks odd but is what the existing
 * numbers do — diverging here would make the board disagree with itself.
 */
export function statusBucket(status) {
  if (status === "cancelled") return "cancelled";
  if (status === "error") return "failed";
  return "completed";
}

// ─── schema ─────────────────────────────────────────────────────────────────

export function rollupTableSql() {
  const counters = COUNTER_COLUMNS.map((c) => `${c} REAL DEFAULT 0`).join(", ");
  const maps = MAP_COLUMNS.map((c) => `${c} TEXT`).join(", ");
  return `CREATE TABLE IF NOT EXISTS ${ROLLUP_TABLE} (
    dateKey TEXT NOT NULL,
    apiKeyId TEXT NOT NULL,
    ${counters},
    completedRequests REAL DEFAULT 0,
    failedRequests REAL DEFAULT 0,
    cancelledRequests REAL DEFAULT 0,
    requestDurationMs REAL DEFAULT 0,
    durationRequestCount REAL DEFAULT 0,
    firstUsed TEXT,
    lastUsed TEXT,
    ${maps},
    periods TEXT,
    weekdays TEXT,
    sessions TEXT,
    PRIMARY KEY (dateKey, apiKeyId)
  )`;
}

export function rollupIndexSql() {
  return `CREATE INDEX IF NOT EXISTS idx_urd_date ON ${ROLLUP_TABLE}(dateKey)`;
}

/**
 * Bookkeeping shared by the writer and the rebuild. `completeThrough` is the
 * last local day the rebuild has fully recomputed. Days after it can be
 * incomplete — a restart mid-day, or the web process's Redis-downgrade fallback
 * (which writes `usageHistory` without the rollup) — so the read path must not
 * trust them and falls back to raw instead.
 */
export const ROLLUP_META_TABLE = "usageRollupMeta";
const COMPLETE_THROUGH_KEY = "completeThrough";

export function rollupMetaTableSql() {
  return `CREATE TABLE IF NOT EXISTS ${ROLLUP_META_TABLE} (key TEXT PRIMARY KEY, value TEXT)`;
}

/**
 * Normalize a database handle to the `{ all, get, run }` adapter shape.
 *
 * Two callers pass different things: the writer holds a raw `node:sqlite`
 * DatabaseSync (so it has `prepare`), while the web process passes its own
 * adapter. Every exported function here funnels through this, because a
 * mismatch is silent — a `raw.get is not a function` inside the writer's
 * background rebuild is caught and logged as "stays on raw", so the rollup
 * would simply never fill and nothing would look broken.
 */
function asAdapter(database) {
  if (database && typeof database.prepare === "function") {
    return {
      all: (sql, p = []) => database.prepare(sql).all(...p),
      get: (sql, p = []) => database.prepare(sql).get(...p),
      run: (sql, p = []) => database.prepare(sql).run(...p),
      exec: (sql) => database.exec(sql),
    };
  }
  return database;
}

/** The legacy alias kept for the callers that already used it. */
const rawOf = asAdapter;

export function getCompleteThrough(database) {
  try {
    const row = asAdapter(database).get(`SELECT value FROM ${ROLLUP_META_TABLE} WHERE key = ?`, [COMPLETE_THROUGH_KEY]);
    return row?.value || null;
  } catch { return null; }
}

/** Advance the completeness marker. Never moves backwards. */
export function setCompleteThrough(database, dateKey) {
  const current = getCompleteThrough(database);
  if (current && current >= dateKey) return;
  asAdapter(database).run(
    `INSERT INTO ${ROLLUP_META_TABLE}(key, value) VALUES(?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [COMPLETE_THROUGH_KEY, dateKey],
  );
}

/**
 * Tables from earlier revisions of this rollup. They are pure derived data that
 * nothing reads once the code moved on, so leaving them would be dead weight in
 * every backup. Dropped once, on boot.
 *
 * `usageRollup` (no suffix) was the dimension-per-row table; `usageRollupUserDay`
 * was the separate per-person table that the current one subsumes.
 */
const LEGACY_ROLLUP_TABLES = ["usageRollup", "usageRollupUserDay"];

/**
 * Create the table and its index if absent. Safe on every boot.
 *
 * A table with the OLD shape is dropped rather than migrated: the rollup is
 * derived data that the rebuild regenerates from `usageHistory`, so a shape
 * change is a rebuild. The completeness marker is cleared with it, so the read
 * path falls back to raw until the next rebuild lands.
 */
export function ensureRollupTable(database) {
  const api = rawOf(database);
  const REQUIRED = ["dateKey", "apiKeyId", "accounts", "endpoints", "sessions"];
  let columns = [];
  try { columns = api.all(`PRAGMA table_info(${ROLLUP_TABLE})`) || []; } catch { columns = []; }
  if (columns.length && !REQUIRED.every((name) => columns.some((c) => c.name === name))) {
    database.exec(`DROP TABLE IF EXISTS ${ROLLUP_TABLE}`);
    try { database.exec(`DELETE FROM ${ROLLUP_META_TABLE} WHERE key = '${COMPLETE_THROUGH_KEY}'`); } catch { /* not created yet */ }
  }
  for (const table of LEGACY_ROLLUP_TABLES) {
    // Best-effort: a locked or missing table must not stop boot.
    try { database.exec(`DROP TABLE IF EXISTS ${table}`); } catch { /* ignore */ }
  }
  database.exec(rollupMetaTableSql());
  database.exec(rollupTableSql());
  database.exec(rollupIndexSql());
}

// ─── session intervals ──────────────────────────────────────────────────────

/** Sort and coalesce intervals within `gapMs`. Result is disjoint and ordered. */
export function normalizeIntervals(intervals, gapMs = SESSION_GAP_MS) {
  const sorted = (intervals || [])
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
 * Absorb every interval the event's gap-expanded box touches, then normalise:
 * the merge can pull two previously-separate intervals together, and only the
 * normalise pass catches that chain.
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
  for (const iv of intervals || []) {
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

function emptyBucket() {
  return { requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0 };
}

function bump(map, key, values) {
  if (key === null || key === undefined || key === "") return;
  const bucket = map[key] || (map[key] = emptyBucket());
  bucket.requests += values.requests ?? 1;
  bucket.promptTokens += values.promptTokens || 0;
  bucket.completionTokens += values.completionTokens || 0;
  bucket.cachedTokens += values.cachedTokens || 0;
  bucket.cost += values.cost || 0;
}

/**
 * The per-(day, key) contribution of one usage event. Pure, so the merge rules
 * are testable without a database.
 *
 * The map keys reproduce the raw aggregation's bucket keys, so the read side can
 * rebuild every dimension without a second grouping:
 *   - models:    `${model}|${provider}`   → byModel, and byProvider via the suffix
 *   - accounts:  `${connectionId}|${model}|${provider}` → byAccount
 *   - endpoints: `${endpoint}|${model}|${provider}`     → byEndpoint
 *   - apps:      the `detectSourceApp` label            → byApp
 *   - sourceIps: the IP                                 → bySourceIp
 * A raw provider is stored, never a display name: `providerNodeNameMap` can
 * change between writes, and `byModel` and `byUser.models` resolve it
 * differently (the former uses the raw id, the latter the display name).
 */
export function rollupRowDelta(event) {
  const tokens = parseJson(event.tokens, {}) || {};
  const meta = parseJson(event.meta, {}) || {};

  const startedAt = event.startedAt || event.timestamp || event.completedAt;
  const completedAt = event.completedAt || startedAt;
  const timestamp = event.timestamp || startedAt;
  const apiKeyId = event.apiKeyId || "local-no-key";
  const dateKey = localDateKey(startedAt);

  const promptTokens = Number(event.promptTokens) || 0;
  const completionTokens = Number(event.completionTokens) || 0;
  const cachedTokens = Number(tokens.cached_tokens ?? tokens.cache_read_input_tokens) || 0;
  const cost = Number(event.cost) || 0;
  const provider = event.provider ?? null;
  const model = event.model ?? null;
  const values = { requests: 1, promptTokens, completionTokens, cachedTokens, cost };

  const models = {};
  // Empty parts stand for null, matching the raw path's template coercion
  // (`${null}` → "null"); the read side reconstructs the display key.
  bump(models, `${model === null ? "" : model}|${provider === null ? "" : provider}`, values);

  const apps = {};
  bump(apps, detectSourceApp(meta), values);

  const sourceIps = {};
  if (meta.sourceIp) bump(sourceIps, meta.sourceIp, values);

  const accounts = {};
  if (event.connectionId) bump(accounts, `${event.connectionId}|${model === null ? "" : model}|${provider === null ? "" : provider}`, values);

  const endpoints = {};
  // Unconditional: the raw path buckets EVERY row by endpoint, even a null model.
  // Empty parts stand for null; the read side re-applies the raw template's
  // coercions (`provider || "unknown"` for the endpoint key).
  bump(endpoints, `${event.endpoint || "Unknown"}|${model === null ? "" : model}|${provider === null ? "" : provider}`, values);

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

  return {
    dateKey,
    apiKeyId,
    counters: values,
    status: { completed: status === "completed" ? 1 : 0, failed: status === "failed" ? 1 : 0, cancelled: status === "cancelled" ? 1 : 0 },
    requestDurationMs: durationMs,
    durationRequestCount: durationMs > 0 ? 1 : 0,
    firstUsed: timestamp,
    lastUsed: timestamp,
    models,
    apps,
    sourceIps,
    accounts,
    endpoints,
    periods,
    weekdays,
    sessions: Number.isFinite(startMs)
      ? [[startMs, Math.max(startMs, Number.isFinite(endMs) ? endMs : startMs)]]
      : [],
  };
}

// ─── merge ──────────────────────────────────────────────────────────────────

function mergeMaps(target, source) {
  const out = { ...(target || {}) };
  for (const [key, value] of Object.entries(source || {})) {
    const bucket = out[key] || (out[key] = emptyBucket());
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
export function mergeRollupRow(existing, delta) {
  const base = existing || {};
  const incoming = delta.sessions?.[0];
  const sessions = incoming
    ? addSessionInterval(parseJson(base.sessions, []) || [], incoming[0], incoming[1])
    : (parseJson(base.sessions, []) || []);
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
    models: mergeMaps(base.models, delta.models),
    apps: mergeMaps(base.apps, delta.apps),
    sourceIps: mergeMaps(base.sourceIps, delta.sourceIps),
    accounts: mergeMaps(base.accounts, delta.accounts),
    endpoints: mergeMaps(base.endpoints, delta.endpoints),
    periods: addArrays(base.periods, delta.periods, 6),
    weekdays: addArrays(base.weekdays, delta.weekdays, 7),
    sessions,
  };
}

const ROW_COLUMNS = [
  "dateKey", "apiKeyId", ...COUNTER_COLUMNS,
  "completedRequests", "failedRequests", "cancelledRequests",
  "requestDurationMs", "durationRequestCount", "firstUsed", "lastUsed",
  ...MAP_COLUMNS, "periods", "weekdays", "sessions",
];

/** Encode a row for storage (the map/array columns as JSON). */
export function serializeRow(row) {
  return ROW_COLUMNS.map((column) => {
    const value = row[column];
    if (MAP_COLUMNS.includes(column) || column === "periods" || column === "weekdays" || column === "sessions") {
      return JSON.stringify(value || (column === "periods" || column === "weekdays" || column === "sessions" ? [] : {}));
    }
    return value ?? null;
  });
}

/** Decode a stored row's JSON columns. */
export function deserializeRow(row) {
  const out = { ...row };
  for (const column of MAP_COLUMNS) out[column] = parseJson(row[column], {}) || {};
  out.periods = parseJson(row.periods, []) || [];
  out.weekdays = parseJson(row.weekdays, []) || [];
  out.sessions = parseJson(row.sessions, []) || [];
  return out;
}

// ─── write ──────────────────────────────────────────────────────────────────

/**
 * Apply one usage event. Runs inside the caller's transaction.
 *
 * Read-modify-write, because sessions and the (key, X) maps are not expressible
 * as SQL increments. The caller must therefore call this EXACTLY once per event
 * (the writer guards on the `usageHistory` insert having changed a row).
 */
export function applyEventToRollup(database, event) {
  const api = rawOf(database);
  const delta = rollupRowDelta(event);
  const existing = api.get(`SELECT * FROM ${ROLLUP_TABLE} WHERE dateKey = ? AND apiKeyId = ?`, [delta.dateKey, delta.apiKeyId]);
  const row = mergeRollupRow(existing ? deserializeRow(existing) : null, delta);
  const placeholders = ROW_COLUMNS.map(() => "?").join(", ");
  const updates = ROW_COLUMNS.filter((c) => c !== "dateKey" && c !== "apiKeyId").map((c) => `${c} = excluded.${c}`).join(", ");

  api.run(
    `INSERT INTO ${ROLLUP_TABLE}(${ROW_COLUMNS.join(", ")}) VALUES(${placeholders})
     ON CONFLICT(dateKey, apiKeyId) DO UPDATE SET ${updates}`,
    serializeRow(row),
  );
}

// ─── rebuild ────────────────────────────────────────────────────────────────

/** Local-day bounds for a `dateKey`, as inclusive `[startMs, endMs]`. */
function dayBounds(dateKey) {
  const [y, m, d] = String(dateKey).split("-").map(Number);
  return [
    new Date(y, m - 1, d, 0, 0, 0, 0).getTime(),
    new Date(y, m - 1, d, 23, 59, 59, 999).getTime(),
  ];
}

/** Which local days `usageHistory` covers, earliest row through `now`. */
export function historyDateKeys(database, now = Date.now()) {
  const row = asAdapter(database).get(`SELECT MIN(COALESCE(startedAt, timestamp)) AS earliest FROM usageHistory`);
  if (!row?.earliest) return [];
  const days = [];
  // Walk APP_TIMEZONE midnights: a fixed 24h step can land mid-day across a DST
  // boundary, and `setDate` would step in the process zone. Adding whole days to
  // the previous instant keeps every cursor exactly on a zone midnight.
  let cursor = startOfDay(row.earliest);
  const end = startOfDay(now);
  while (cursor.getTime() <= end.getTime()) {
    days.push(localDateKey(cursor.getTime()));
    const wc = new Date(cursor.getTime() + 26 * 3600_000); // +26h is safely into the next day
    cursor = startOfDay(wc);
  }
  return days;
}

/** Is the rollup behind `usageHistory` (or shaped for a different day basis)? */
export function rollupNeedsBackfill(database, now = Date.now()) {
  const completeThrough = getCompleteThrough(database);
  const days = historyDateKeys(database, now);
  if (!days.length) return false;
  if (!completeThrough) return true;
  return completeThrough < days[days.length - 1];
}

/**
 * Rebuild rollup days from `usageHistory`.
 *
 * REBUILD, not "fill missing": a day already present is deleted and recomputed.
 * Filling only absent days cannot repair a day the writer started mid-way
 * through — on the production upgrade the writer began at 05:43, so "today" held
 * 05:43→now and the earlier hours were simply absent. Rebuilding is also what
 * makes the pass re-runnable after a shape change.
 *
 * EACH DAY IS ONE TRANSACTION (delete + rescan + insert). A correctness
 * requirement, not a tidy-up: the live writer inserts a `usageHistory` row and
 * its rollup counters in the SAME transaction, so the two agree at every
 * transaction boundary. Splitting the rebuild's read, delete and insert across
 * transactions lets a writer insert land between the read and the delete and be
 * silently dropped.
 *
 * A day is scanned on `timestamp` (so `idx_uh_ts` is usable) with the lower
 * bound reaching back a day, because a row's `startedAt` can precede the day its
 * `completedAt` falls in; the JS side then assigns each row to exactly one day
 * by `startedAt`, matching how the writer keys `dateKey`.
 *
 * @returns {Promise<{ days: number, scanned: number, applied: number, completeThrough: string|null }>}
 */
export async function rebuildRollupDays(database, { days = null, onYield = null, now = Date.now() } = {}) {
  const adapter = asAdapter(database);
  const targets = days || historyDateKeys(database, now);
  let scanned = 0;
  let applied = 0;
  let built = 0;

  for (const dateKey of targets) {
    const [dayStart, dayEnd] = dayBounds(dateKey);
    const rows = adapter.all(
      `SELECT timestamp, startedAt, completedAt, provider, model, connectionId, apiKeyId, endpoint,
              promptTokens, completionTokens, cost, status, tokens, meta
         FROM usageHistory
        WHERE timestamp >= ? AND timestamp <= ?`,
      [new Date(dayStart - 86400_000).toISOString(), new Date(dayEnd).toISOString()],
    );

    adapter.exec("BEGIN");
    try {
      adapter.run(`DELETE FROM ${ROLLUP_TABLE} WHERE dateKey = ?`, [dateKey]);
      // Fold the whole day in memory and write once per (day, key): a
      // read-modify-write per event would be a statement per row, and this pass
      // already holds the day's rows.
      const byKey = new Map();
      for (const row of rows) {
        scanned++;
        if (localDateKey(row.startedAt || row.timestamp) !== dateKey) continue;
        const delta = rollupRowDelta(row);
        byKey.set(delta.apiKeyId, mergeRollupRow(byKey.get(delta.apiKeyId) || null, delta));
        applied++;
      }
      const placeholders = ROW_COLUMNS.map(() => "?").join(", ");
      for (const row of byKey.values()) {
        adapter.run(`INSERT INTO ${ROLLUP_TABLE}(${ROW_COLUMNS.join(", ")}) VALUES(${placeholders})`, serializeRow(row));
      }
      adapter.exec("COMMIT");
      setCompleteThrough(adapter, dateKey);
      built++;
    } catch (error) {
      try { adapter.exec("ROLLBACK"); } catch {}
      throw error;
    }
    if (onYield) await onYield();
  }

  return { days: built, scanned, applied, completeThrough: getCompleteThrough(adapter) };
}
