/**
 * Incremental daily rollup for usage stats.
 *
 * WHY: every dashboard query scans `usageHistory` (206k rows for 7 days on the
 * production gateway; ~880k for 30d). The same 8 dimensions are re-aggregated
 * from raw rows on every poll. A daily rollup turns a 30d scan into ~16k bucket
 * reads (~55x less), and — because it is tiny — can be retained far longer than
 * the raw table, which is what bounds the long-range views today.
 *
 * This module is the WRITE side only. It is called by `usage-writer.mjs` right
 * after a `usageHistory` row is inserted, so the rollup accumulates from the
 * same single writer and needs no extra coordination. Nothing reads it yet —
 * that is deliberate: the table accumulates data first so the rollup can be
 * reconciled against raw rows before anything depends on it.
 *
 * IDEMPOTENCE: the caller only calls this when the INSERT actually changed a row
 * (`changes > 0`). Re-delivered Redis events hit `INSERT OR IGNORE` and report
 * `changes: 0`, so they never double-count.
 *
 * SCOPE — counters only. The five counter columns cover requests, tokens and
 * cost for all 8 dimensions. Two per-person fields are NOT derivable from
 * counters and are deliberately absent: `sessionCount` and
 * `activeSessionDurationMs`. They require the ordered sequence of a user's
 * events (sessions are runs of events no more than 30 minutes apart, merged
 * across day boundaries), which incremental counter accumulation cannot
 * reconstruct — and the writer sees events in completion order, not strict
 * time order. Those two fields must be solved before the read path switches
 * over; see the note at the bottom of this file.
 *
 * CONSTRAINTS (same as usage-aggregate.mjs — see its header): this file lives in
 * `runtime/`, which is the only directory shipped as real files in the image, so
 * it must stay free of `@/` and `open-sse/` alias imports. Only Node built-ins
 * and relative imports inside `runtime/` are allowed.
 *
 * KEY DESIGN: bucket keys store RAW identifiers (`provider` id, `model`,
 * `connectionId`, `apiKeyId`), never display names. Display names come from
 * lookup maps (`connectionMap`, `apiKeyMap`, `providerNodeNameMap`) that can
 * change between writes, so resolving them at write time would bake stale labels
 * into the rollup. The read path resolves them, exactly like the raw path does.
 */

import { detectSourceApp } from "./usage-aggregate.mjs";

export const ROLLUP_TABLE = "usageRollup";

/** The dimensions the dashboard aggregates over. One row per dimension per day per bucket. */
export const ROLLUP_DIMENSIONS = [
  "provider",
  "model",
  "account",
  "apiKey",
  "endpoint",
  "sourceIp",
  "app",
  "user",
  // Status counts for the board's completed/failed/cancelled cards. A plain
  // dimension rather than a cross of the others, so it stays cheap.
  "status",
];

/** Counter columns, mirroring the raw aggregation's bucket shape. */
export const COUNTER_COLUMNS = ["requests", "promptTokens", "completionTokens", "cachedTokens", "cost"];

function localDateKey(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function parseJson(value, fallback = null) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "object") return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

/**
 * Derive every rollup bucket for one usage event.
 *
 * Returns `[{ dimension, bucketKey, meta, counters }]`. Kept as a pure function
 * so it can be unit-tested against the raw aggregation without a database.
 *
 * @param {object} event  a usageHistory-shaped row (same fields the writer inserts)
 */
export function rollupBucketsForEvent(event) {
  const tokens = parseJson(event.tokens, {}) || {};
  const meta = parseJson(event.meta, {}) || {};

  const promptTokens = Number(event.promptTokens) || 0;
  const completionTokens = Number(event.completionTokens) || 0;
  const cachedTokens = Number(tokens.cached_tokens ?? tokens.cache_read_input_tokens) || 0;
  const cost = Number(event.cost) || 0;

  // Every dimension gets the same counter shape; `requests` counts the event.
  const counters = { requests: 1, promptTokens, completionTokens, cachedTokens, cost };

  const provider = event.provider || null;
  const model = event.model || null;
  const providerPart = provider || "unknown";
  const out = [];

  const push = (dimension, bucketKey, extraMeta = {}) => {
    if (bucketKey === null || bucketKey === undefined || bucketKey === "") return;
    out.push({ dimension, bucketKey: String(bucketKey), meta: extraMeta, counters });
  };

  // provider — bucket key is the raw provider id. The raw aggregation indexes
  // `byProvider[r.provider]` unconditionally, so a null provider becomes a
  // "null" bucket there (it holds non-billing endpoints like count_tokens).
  // Mirror that exactly, or the two paths disagree on the request count.
  push("provider", provider === null || provider === undefined ? "null" : provider);

  // model — keyed by model AND provider, matching the raw path's
  // `${model} (${provider})` bucket. The provider must be part of the key, not
  // just meta: the same model id is served by several channels (on production
  // `deepseek-v4.1-flash` appears under 6 providers), and the raw path keeps
  // those as separate buckets. Keying on the model alone silently merges them.
  if (model) push("model", `${model}|${providerPart}`, { rawModel: model, provider });

  // account — per connection+model+provider, matching the raw bucket key.
  if (event.connectionId) {
    push("account", `${event.connectionId}|${model || ""}|${providerPart}`, {
      connectionId: event.connectionId, rawModel: model, provider,
    });
  }

  // apiKey — keyed by the stored apiKeyId (raw), not the masked display value.
  const apiKeyId = event.apiKeyId || "local-no-key";
  if (model) {
    push("apiKey", `${apiKeyId}|${model}|${providerPart}`, {
      apiKey: apiKeyId, rawModel: model, provider,
    });
  }

  // endpoint
  const endpoint = event.endpoint || "Unknown";
  if (model) {
    push("endpoint", `${endpoint}|${model}|${providerPart}`, {
      endpoint, rawModel: model, provider,
    });
  }

  // sourceIp — only when captured; geo is resolved at read time.
  if (meta.sourceIp) {
    push("sourceIp", meta.sourceIp, { sourceIp: meta.sourceIp });
  }

  // app — normalised at write time (the detector is deterministic and cheap).
  push("app", detectSourceApp(meta));

  // user — the person key, same as the raw path (`apiKeyId` || local-no-key).
  push("user", apiKeyId, { userId: apiKeyId });

  // status — normalised to the three buckets the board counts, matching the raw
  // path's EXACT-match rule (`status === "cancelled"` / `"error"`, everything
  // else completed). Statuses like `blocked:account_locked` or `upstream:503`
  // therefore count as completed, which looks odd but is what the existing
  // numbers do — diverging here would make the board disagree with itself
  // across the rollup boundary.
  push("status", statusBucket(event.status));

  return out;
}

/**
 * Map a raw status onto the bucket the board counts.
 * Kept exported so the read path and tests share the exact rule.
 */
export function statusBucket(status) {
  if (status === "cancelled") return "cancelled";
  if (status === "error") return "failed";
  return "completed";
}

/**
 * Build the rollup table DDL. Kept here rather than in `src/lib/db/schema.js`
 * because the writer owns the table: it must exist even if the web process never
 * booted, and the writer cannot import from `src/`.
 */
export function rollupTableSql() {
  const counters = COUNTER_COLUMNS.map((c) => `${c} REAL DEFAULT 0`).join(", ");
  return `CREATE TABLE IF NOT EXISTS ${ROLLUP_TABLE} (
    dateKey TEXT NOT NULL,
    dimension TEXT NOT NULL,
    bucketKey TEXT NOT NULL,
    ${counters},
    meta TEXT,
    PRIMARY KEY (dateKey, dimension, bucketKey)
  )`;
}

export function rollupIndexSql() {
  return `CREATE INDEX IF NOT EXISTS idx_ur_dim_date ON ${ROLLUP_TABLE}(dimension, dateKey)`;
}

/** Create the table and its index if absent. Safe to call on every boot. */
export function ensureRollupTable(database) {
  database.exec(rollupTableSql());
  database.exec(rollupIndexSql());
}

/**
 * Apply one usage event to the rollup. Runs inside the caller's transaction.
 *
 * @param {object} database  a `node:sqlite` DatabaseSync (the writer's connection)
 * @param {object} event     a usageHistory-shaped row
 */
export function applyEventToRollup(database, event) {
  const dateKey = localDateKey(new Date(event.completedAt || event.timestamp || Date.now()).getTime());

  for (const bucket of rollupBucketsForEvent(event)) {
    const c = bucket.counters;
    database.prepare(
      `INSERT INTO ${ROLLUP_TABLE}(dateKey, dimension, bucketKey, requests, promptTokens, completionTokens, cachedTokens, cost, meta)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(dateKey, dimension, bucketKey) DO UPDATE SET
         requests = requests + excluded.requests,
         promptTokens = promptTokens + excluded.promptTokens,
         completionTokens = completionTokens + excluded.completionTokens,
         cachedTokens = cachedTokens + excluded.cachedTokens,
         cost = cost + excluded.cost`,
    ).run(
      dateKey, bucket.dimension, bucket.bucketKey,
      c.requests, c.promptTokens, c.completionTokens, c.cachedTokens, c.cost,
      JSON.stringify(bucket.meta || {}),
    );
  }
}

// ─── Known gap: per-person session metrics ──────────────────────────────────
//
// `byUser` in the raw aggregation carries `sessionCount` and
// `activeSessionDurationMs`, which the personnel report renders. They are
// computed from the ordered sequence of a user's events (a session is a run of
// events no more than SESSION_GAP_MS = 30min apart; sessions spanning local
// midnight are one session, not two).
//
// Counters cannot reconstruct this, so the read path must not claim those two
// fields for rolled-up days until it is solved. Options, in rough order of
// preference:
//   1. Store per (user, day) the first/last event timestamps plus the boundary
//      session spans, and merge adjacent days with the correction
//      `sessions = a + b - 1` when `a.lastEventAt + GAP >= b.firstEventAt`.
//      Measured on production: 72 of 1518 sessions span a day boundary, so the
//      correction is required, not cosmetic.
//   2. Compute the two fields from raw rows for the requested range and leave
//      the rest of the person report on the rollup.
//   3. Drop the two fields for days older than the raw retention window and say
//      so in the UI.
//
// The writer sees events in completion order (concurrent requests can land out
// of order), so any incremental sessionisation must tolerate that.
