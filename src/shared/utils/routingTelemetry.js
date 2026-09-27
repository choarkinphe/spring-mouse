// Pure, synchronous routing telemetry event normalization and persistence.
//
// This module deliberately has no database-adapter imports.  The writer accepts
// the small adapter surface shared by every SQLite implementation: run(sql,
// params) and get(sql, params).  Producers may enqueue the same event for a
// later writer without changing its shape.

import { randomUUID } from "node:crypto";

export const ROUTING_STREAM_KEY = "spring-mouse:routing:events";
export const ROUTING_STREAM_GROUP = "routing-writers";

export const ROUTING_OUTCOMES = Object.freeze([
  "valid_terminal",
  "failed",
  "cancelled",
  "incomplete",
  "unknown",
]);

export const ROUTING_ROLES = Object.freeze([
  "primary",
  "panel",
  "judge",
  "classifier",
  "autoCandidate",
  "other",
]);

export const ROUTING_STRATEGIES = Object.freeze([
  "single",
  "fallback",
  "round-robin",
  "auto",
  "fusion",
  "unknown",
]);

// Reasons are intentionally an enum.  In particular, upstream exception
// messages and response bodies must never be persisted as telemetry fields.
export const ROUTING_TERMINAL_REASONS = Object.freeze([
  "invalid_json",
  "auth_rejected",
  "missing_model",
  "access_denied",
  "unsupported_capability",
  "bypass",
  "queue_timeout",
  "breaker_open",
  "model_overloaded",
  "account_locked",
  "no_account",
  "accounts_exhausted",
  "transport_error",
  "upstream_http_error",
  "internal_error",
  "client_abort",
  "model_fallback",
  "account_fallback",
  "response_unobserved",
  "stream_error",
  "output_error",
  // Compatibility names emitted by the response observer. They remain fixed
  // enums; arbitrary upstream exception text is still rejected.
  "terminal",
  "upstream_error",
  "incomplete",
  "parse_error",
  "response_error",
  "unknown",
]);

export const ROUTING_META_KEYS = Object.freeze([
  "toolsCount",
  "hasImages",
  "hasReasoning",
  "autoLatencyMs",
  "classifierConfidence",
  "hasTools",
  "hasToolHistory",
  "hasLongContext",
  "hasMultimodalInput",
  "messageCount",
]);

const REQUEST_COLUMNS = Object.freeze([
  "routingRequestId",
  "modelCallId",
  "trafficRequestId",
  "originalModel",
  "endpoint",
  "role",
  "requestType",
  "comboName",
  "strategy",
  "autoSource",
  "autoLevel",
  "autoConfidence",
  "startedAt",
  "completedAt",
  "outcome",
  "terminalReason",
  "attemptCount",
  "meta",
]);

const ATTEMPT_COLUMNS = Object.freeze([
  "attemptId",
  "routingRequestId",
  "modelCallId",
  "role",
  "provider",
  "model",
  "connectionId",
  "routeIndex",
  "candidateIndex",
  "sourceFormat",
  "targetFormat",
  "nativePassthrough",
  "streamMode",
  "startedAt",
  "completedAt",
  "upstreamStatus",
  "outcome",
  "fallbackReason",
  "terminalReason",
  "ttftMs",
  "durationMs",
  "promptTokens",
  "completionTokens",
  "meta",
]);

const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const MAX_TEXT = 256;
const MAX_REPORT_SAFE_TEXT = 160;
const TERMINAL_OUTCOMES = new Set(ROUTING_OUTCOMES.filter((value) => value !== "unknown"));
const OUTCOME_SET = new Set(ROUTING_OUTCOMES);
const ROLE_SET = new Set(ROUTING_ROLES);
const STRATEGY_SET = new Set(ROUTING_STRATEGIES);
const REASON_SET = new Set(ROUTING_TERMINAL_REASONS);
const META_SET = new Set(ROUTING_META_KEYS);
const META_NUMBER_KEYS = new Set([
  "toolsCount",
  "autoLatencyMs",
  "classifierConfidence",
  "messageCount",
]);
const META_BOOLEAN_KEYS = new Set(ROUTING_META_KEYS.filter((key) => !META_NUMBER_KEYS.has(key)));

// These columns identify the routing graph rather than a mutable snapshot. A
// replay can arrive with a stale/conflicting value, but changing one of these
// values would attach a terminal observation to a different request/parent or
// change the privacy classification of an already persisted row.
const IMMUTABLE_COLUMNS = Object.freeze({
  request: Object.freeze(["routingRequestId", "modelCallId", "trafficRequestId", "role", "originalModel"]),
  attempt: Object.freeze(["attemptId", "routingRequestId", "modelCallId", "role"]),
});

function hasValue(value) {
  return value !== undefined && value !== null && value !== "";
}

function validId(value) {
  return typeof value === "string" && value.length >= 1 && value.length <= 128 && REQUEST_ID.test(value)
    ? value
    : null;
}

function hasInvalidOptionalId(source, key) {
  const value = source[key];
  return value !== undefined && value !== null && value !== "" && !validId(value);
}

function text(value, max = MAX_TEXT) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" && typeof value !== "number") return null;
  const clean = String(value).replace(/[\x00-\x1f\x7f]/g, " ").trim();
  return clean ? clean.slice(0, max) : null;
}

function finiteNumber(value, { integer = false, minimum = null } = {}) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const normalized = integer ? Math.round(value) : value;
  if (minimum !== null && normalized < minimum) return null;
  return normalized;
}

function integer(value, minimum = 0) {
  if (typeof value === "number") return finiteNumber(value, { integer: true, minimum });
  // Numeric strings are accepted only for SQLite-row compatibility, never for
  // meta values.  This keeps event metadata strict while allowing API patches.
  if (typeof value === "string" && value.trim() !== "") {
    const numberValue = Number(value);
    return Number.isFinite(numberValue) ? Math.max(minimum, Math.round(numberValue)) : null;
  }
  return null;
}

function normalizeTimestamp(value, fallback = null) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value !== "string" && !(value instanceof Date)) return fallback;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : fallback;
}

function normalizeOutcome(value) {
  return typeof value === "string" && OUTCOME_SET.has(value) ? value : "unknown";
}

function normalizeRole(value) {
  return typeof value === "string" && ROLE_SET.has(value) ? value : "primary";
}

function normalizeStrategy(value) {
  return typeof value === "string" && STRATEGY_SET.has(value) ? value : "unknown";
}

function normalizeReason(value, { nullable = true } = {}) {
  if (value === undefined || value === null || value === "") return nullable ? null : "unknown";
  return typeof value === "string" && REASON_SET.has(value) ? value : "unknown";
}

function normalizeMeta(value) {
  if (typeof value === "string") {
    try { value = JSON.parse(value); } catch { return "{}"; }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return "{}";
  const out = {};
  // Iterate in the published order so equivalent metadata has deterministic
  // JSON, which is useful for idempotent stream replay and tests.  Each key has
  // one fixed primitive type: this prevents producer/writer double-normalization
  // from turning booleans into numbers (or vice versa) and keeps the persisted
  // shape bounded and machine-readable.
  for (const key of ROUTING_META_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    const item = value[key];
    if (META_NUMBER_KEYS.has(key)) {
      if (typeof item !== "number" || !Number.isFinite(item)) continue;
      out[key] = item;
    } else if (META_BOOLEAN_KEYS.has(key) && typeof item === "boolean") {
      out[key] = item;
    }
  }
  return JSON.stringify(out);
}

function isMeaningful(value) {
  return hasValue(value) && value !== "unknown" && value !== "{}";
}

function normalizeRequest(input, { requireId = true } = {}) {
  const source = input && typeof input === "object" ? input : {};
  const id = validId(source.routingRequestId);
  if (requireId && (!id || hasInvalidOptionalId(source, "modelCallId") || hasInvalidOptionalId(source, "trafficRequestId"))) return null;
  const completedAt = normalizeTimestamp(source.completedAt);
  const startedAt = normalizeTimestamp(source.startedAt, completedAt || new Date().toISOString());
  return {
    routingRequestId: id || randomUUID(),
    modelCallId: validId(source.modelCallId),
    trafficRequestId: validId(source.trafficRequestId),
    originalModel: text(source.originalModel),
    endpoint: text(source.endpoint),
    role: normalizeRole(source.role),
    requestType: text(source.requestType, 64),
    comboName: text(source.comboName, 128),
    strategy: normalizeStrategy(source.strategy),
    autoSource: normalizeAutoSource(source.autoSource),
    autoLevel: text(source.autoLevel, 64),
    autoConfidence: finiteNumber(source.autoConfidence),
    startedAt,
    completedAt,
    outcome: normalizeOutcome(source.outcome),
    terminalReason: normalizeReason(source.terminalReason),
    attemptCount: integer(source.attemptCount, 0) ?? 0,
    meta: normalizeMeta(source.meta),
  };
}

function normalizeAutoSource(value) {
  if (value === undefined || value === null || value === "") return null;
  return ["default", "classifier", "manual", "unknown"].includes(value) ? value : "unknown";
}

function normalizeAttempt(input, { requireId = true } = {}) {
  const source = input && typeof input === "object" ? input : {};
  const id = validId(source.attemptId);
  const requestId = validId(source.routingRequestId);
  if (requireId && (!id || !requestId || hasInvalidOptionalId(source, "modelCallId") || hasInvalidOptionalId(source, "connectionId"))) return null;
  const completedAt = normalizeTimestamp(source.completedAt);
  const startedAt = normalizeTimestamp(source.startedAt, completedAt || new Date().toISOString());
  return {
    attemptId: id || randomUUID(),
    routingRequestId: requestId || "unknown",
    modelCallId: validId(source.modelCallId),
    role: normalizeRole(source.role),
    provider: text(source.provider, 96),
    model: text(source.model),
    connectionId: validId(source.connectionId),
    routeIndex: integer(source.routeIndex, 0),
    candidateIndex: integer(source.candidateIndex, 0),
    sourceFormat: text(source.sourceFormat, 64),
    targetFormat: text(source.targetFormat, 64),
    nativePassthrough: source.nativePassthrough === true || source.nativePassthrough === 1 ? 1 : 0,
    streamMode: text(source.streamMode, 32),
    startedAt,
    completedAt,
    upstreamStatus: integer(source.upstreamStatus, 100),
    outcome: normalizeOutcome(source.outcome),
    fallbackReason: normalizeReason(source.fallbackReason),
    terminalReason: normalizeReason(source.terminalReason),
    ttftMs: integer(source.ttftMs, 0),
    durationMs: integer(source.durationMs, 0),
    promptTokens: integer(source.promptTokens, 0),
    completionTokens: integer(source.completionTokens, 0),
    meta: normalizeMeta(source.meta),
  };
}

function values(record, columns) {
  return columns.map((column) => record[column]);
}

function tableFor(kind) {
  return kind === "request" ? "routingRequests" : "routingAttempts";
}

function idColumnFor(kind) {
  return kind === "request" ? "routingRequestId" : "attemptId";
}

function coalesceAssignments(columns, table, kind) {
  return columns
    .filter((column) => column !== idColumnFor(kind))
    .map((column) => {
      if (IMMUTABLE_COLUMNS[kind].includes(column)) {
        // Identity is latched on first observation. A replay may fill a field
        // that was initially absent, but can never replace a persisted value.
        return `${column} = CASE WHEN ${table}.${column} IS NOT NULL AND ${table}.${column} <> '' THEN ${table}.${column} ELSE excluded.${column} END`;
      }
      if (column === "startedAt") {
        // Replayed start events can arrive after a finish event. Keep the
        // earliest observed timestamp rather than allowing a late start to move
        // the request forward in time.
        return `${column} = CASE WHEN excluded.${column} < ${table}.${column} THEN excluded.${column} ELSE ${table}.${column} END`;
      }
      if (column === "outcome") {
        return `${column} = CASE WHEN ${table}.outcome <> 'unknown' THEN ${table}.outcome ELSE excluded.outcome END`;
      }
      if (column === "completedAt") {
        // A terminal outcome latches its completion timestamp. An unknown/start
        // replay can only leave an existing timestamp alone; a real completion
        // may fill one that was missing.
        return `${column} = CASE
          WHEN ${table}.outcome <> 'unknown' THEN
            CASE WHEN ${table}.${column} IS NOT NULL THEN ${table}.${column}
                 WHEN excluded.outcome <> 'unknown' THEN excluded.${column}
                 ELSE ${table}.${column} END
          WHEN excluded.outcome <> 'unknown' THEN COALESCE(excluded.${column}, ${table}.${column})
          ELSE ${table}.${column}
        END`;
      }
      if (column === "terminalReason") {
        // Do not let a progress/start snapshot add or replace terminal detail.
        // A later real completion is allowed to enrich a terminal row whose
        // reason was absent, while a non-unknown reason is always latched.
        return `${column} = CASE
          WHEN ${table}.${column} IS NOT NULL AND ${table}.${column} <> 'unknown' THEN ${table}.${column}
          WHEN excluded.outcome <> 'unknown' THEN COALESCE(excluded.${column}, ${table}.${column})
          ELSE ${table}.${column}
        END`;
      }
      if (column === "attemptCount") {
        return `${column} = MAX(${table}.${column}, excluded.${column})`;
      }
      if (column === "nativePassthrough") {
        return `${column} = MAX(${table}.${column}, excluded.${column})`;
      }
      if (column === "meta") {
        // Terminal metadata is retained, while a terminal row may still be
        // enriched if it was created without metadata.
        return `${column} = CASE WHEN ${table}.outcome <> 'unknown' AND ${table}.${column} <> '{}' THEN ${table}.${column} WHEN excluded.${column} <> '{}' THEN excluded.${column} ELSE ${table}.${column} END`;
      }
      // A replayed start may fill an empty field but cannot replace a value
      // captured by a terminal snapshot.
      return `${column} = CASE WHEN ${table}.outcome <> 'unknown' AND ${table}.${column} IS NOT NULL AND ${table}.${column} <> 'unknown' THEN ${table}.${column} ELSE COALESCE(excluded.${column}, ${table}.${column}) END`;
    })
    .join(", ");
}

function makeUpsertSql(kind) {
  const columns = kind === "request" ? REQUEST_COLUMNS : ATTEMPT_COLUMNS;
  const table = tableFor(kind);
  const quotedColumns = columns.join(", ");
  const placeholders = columns.map(() => "?").join(", ");
  return `INSERT INTO ${table} (${quotedColumns}) VALUES (${placeholders}) ON CONFLICT(${idColumnFor(kind)}) DO UPDATE SET ${coalesceAssignments(columns, table, kind)}`;
}

/**
 * Normalize an event without touching the database.
 *
 * Returns null for malformed events, including missing/overlong identifiers.
 * Callers should treat null as a dropped telemetry event, not as a request
 * failure.
 */
export function normalizeRoutingEvent(event) {
  if (!event || typeof event !== "object" || Array.isArray(event)) return null;
  const kind = event.kind;
  if (kind !== "request" && kind !== "attempt") return null;
  const input = event.record && typeof event.record === "object" ? event.record : event;
  const record = kind === "request" ? normalizeRequest(input) : normalizeAttempt(input);
  return record ? { kind, record } : null;
}

/**
 * Persist one normalized full snapshot synchronously.
 *
 * `db` intentionally only needs `run(sql, params)` and `get(sql, params)` so
 * this can be used by the normal SQLite adapter and by a stream worker.  The
 * terminal outcome/completedAt pair is latched in SQL; out-of-order start
 * snapshots therefore cannot undo a finished event.
 */
export function writeRoutingEvent(db, event) {
  if (!db || typeof db.run !== "function" || typeof db.get !== "function") return null;
  const normalized = normalizeRoutingEvent(event);
  if (!normalized) return null;
  const { kind, record } = normalized;
  const columns = kind === "request" ? REQUEST_COLUMNS : ATTEMPT_COLUMNS;
  const idColumn = idColumnFor(kind);
  let result;
  let before;
  try {
    before = db.get(`SELECT * FROM ${tableFor(kind)} WHERE ${idColumn} = ?`, [record[idColumn]]) || null;
    result = db.run(makeUpsertSql(kind), values(record, columns));
    // Read the row once more so stream workers can verify that the synchronous
    // adapter completed the write. It also keeps the adapter contract honest on
    // drivers whose run() result does not expose a portable changes count.
    db.get(`SELECT ${idColumn} FROM ${tableFor(kind)} WHERE ${idColumn} = ?`, [record[idColumn]]);
  } catch {
    return null;
  }
  return {
    kind,
    record,
    changed: Number(result?.changes || 0) > 0,
    inserted: !before,
  };
}

export const __test__ = Object.freeze({
  REQUEST_COLUMNS,
  ATTEMPT_COLUMNS,
  validId,
  normalizeMeta,
  normalizeRequest,
  normalizeAttempt,
  makeUpsertSql,
  terminalOutcomes: TERMINAL_OUTCOMES,
  metaSet: META_SET,
  safeTextMax: MAX_REPORT_SAFE_TEXT,
});
