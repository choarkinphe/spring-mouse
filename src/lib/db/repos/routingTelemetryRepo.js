import { randomUUID } from "node:crypto";
import { getAdapter } from "../driver.js";
import {
  ROUTING_OUTCOMES,
  ROUTING_ROLES,
  ROUTING_STRATEGIES,
  ROUTING_TERMINAL_REASONS,
  normalizeRoutingEvent,
  writeRoutingEvent,
} from "../../../shared/utils/routingTelemetry.js";

const OUTCOME_SET = new Set(ROUTING_OUTCOMES);
const ROLE_SET = new Set(ROUTING_ROLES);
const STRATEGY_SET = new Set(ROUTING_STRATEGIES);
const REASON_SET = new Set(ROUTING_TERMINAL_REASONS);

export const DEFAULT_REPORT_DAYS = 7;
export const MAX_REPORT_DAYS = 30;
export const MAX_REPORT_GROUPS = 100;
export const MAX_LATENCY_SAMPLE = 10_000;
export const REPORT_SAMPLE_STRATEGY = "recent-by-startedAt-desc-attemptId-desc";

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_DATETIME_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/;
const TERMINAL_OUTCOMES = new Set(ROUTING_OUTCOMES.filter((value) => value !== "unknown"));

function isId(value) {
  return typeof value === "string" && ID_RE.test(value);
}

function isValidCalendarDate(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

function parseStrictIsoDate(value, label) {
  if (typeof value !== "string") throw new RangeError(`${label} must be an ISO date`);

  const dateOnly = value.match(ISO_DATE_RE);
  if (dateOnly) {
    const year = Number(dateOnly[1]);
    const month = Number(dateOnly[2]);
    const day = Number(dateOnly[3]);
    if (!isValidCalendarDate(year, month, day)) throw new RangeError(`Invalid ${label}`);
    return Date.UTC(year, month - 1, day);
  }

  const datetime = value.match(ISO_DATETIME_RE);
  if (!datetime) throw new RangeError(`${label} must be an ISO date`);
  const year = Number(datetime[1]);
  const month = Number(datetime[2]);
  const day = Number(datetime[3]);
  const hour = Number(datetime[4]);
  const minute = Number(datetime[5]);
  const second = Number(datetime[6]);
  const offset = datetime[8];
  const [offsetHour, offsetMinute] = offset === "Z"
    ? [0, 0]
    : offset.slice(1).split(":").map(Number);
  if (!isValidCalendarDate(year, month, day)
    || hour > 23 || minute > 59 || second > 59
    || offsetHour > 23 || offsetMinute > 59) {
    throw new RangeError(`Invalid ${label}`);
  }
  const milliseconds = datetime[7] ? Number(`0.${datetime[7]}`) * 1000 : 0;
  const utc = Date.UTC(year, month - 1, day, hour, minute, second, milliseconds);
  const sign = offset === "Z" ? 1 : (offset[0] === "+" ? -1 : 1);
  const timestamp = utc + sign * (offsetHour * 60 + offsetMinute) * 60_000;
  if (!Number.isFinite(timestamp)) throw new RangeError(`Invalid ${label}`);
  return timestamp;
}

function parseOptionalDate(value, label) {
  if (value === undefined || value === null || value === "") return null;
  return parseStrictIsoDate(value, label);
}

function text(value, max = 160) {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const clean = String(value).replace(/[\x00-\x1f\x7f]/g, " ").trim();
  return clean ? clean.slice(0, max) : null;
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

function normalizeReason(value) {
  return value === null || value === undefined || value === ""
    ? null
    : (typeof value === "string" && REASON_SET.has(value) ? value : "unknown");
}

function normalizeCount(value) {
  const count = Number(value);
  return Number.isFinite(count) ? Math.max(0, Math.round(count)) : 0;
}

function normalizeId(value) {
  return isId(value) ? value : null;
}

function normalizeRequestInput(input = {}, current = null) {
  return {
    ...(current || {}),
    ...input,
    routingRequestId: input.routingRequestId || current?.routingRequestId || randomUUID(),
    // DB rows store metadata as JSON text; the shared helper accepts either
    // representation and applies its strict allowlist before writing.
    meta: input.meta === undefined ? current?.meta : input.meta,
  };
}

function normalizeAttemptInput(input = {}, current = null) {
  return {
    ...(current || {}),
    ...input,
    attemptId: input.attemptId || current?.attemptId || randomUUID(),
    routingRequestId: input.routingRequestId || current?.routingRequestId || "unknown",
    meta: input.meta === undefined ? current?.meta : input.meta,
  };
}

async function dbWriteEvent(db, event) {
  const result = writeRoutingEvent(db, event);
  return result ? result : null;
}

export async function createRoutingRequest(input = {}) {
  const db = await getAdapter();
  const record = normalizeRequestInput(input);
  const event = normalizeRoutingEvent({ kind: "request", record });
  if (!event) return null;
  const result = await dbWriteEvent(db, event);
  return result ? result.record.routingRequestId : null;
}

export async function updateRoutingRequest(routingRequestId, patch = {}) {
  if (!isId(routingRequestId)) return false;
  const db = await getAdapter();
  const current = db.get("SELECT * FROM routingRequests WHERE routingRequestId = ?", [routingRequestId]);
  if (!current) return false;
  const event = normalizeRoutingEvent({
    kind: "request",
    record: normalizeRequestInput({ ...patch, routingRequestId }, current),
  });
  if (!event) return false;
  return !!(await dbWriteEvent(db, event))?.changed;
}

export async function completeRoutingRequest(routingRequestId, patch = {}) {
  if (!isId(routingRequestId)) return false;
  const db = await getAdapter();
  const current = db.get("SELECT * FROM routingRequests WHERE routingRequestId = ?", [routingRequestId]);
  if (!current) return false;
  const event = normalizeRoutingEvent({
    kind: "request",
    record: normalizeRequestInput({
      ...patch,
      routingRequestId,
      completedAt: patch.completedAt || new Date().toISOString(),
      outcome: patch.outcome === undefined ? "unknown" : patch.outcome,
    }, current),
  });
  if (!event) return false;
  return !!(await dbWriteEvent(db, event))?.changed;
}

export async function createRoutingAttempt(input = {}) {
  const db = await getAdapter();
  const event = normalizeRoutingEvent({ kind: "attempt", record: normalizeAttemptInput(input) });
  if (!event) return { attemptId: null, inserted: false };
  const result = await dbWriteEvent(db, event);
  return {
    attemptId: event.record.attemptId,
    inserted: !!result?.inserted,
  };
}

// Kept as a descriptive alias for callers that record an attempt event.
export const recordRoutingAttempt = createRoutingAttempt;

export async function completeRoutingAttempt(attemptId, patch = {}) {
  if (!isId(attemptId)) return false;
  const db = await getAdapter();
  const current = db.get("SELECT * FROM routingAttempts WHERE attemptId = ?", [attemptId]);
  if (!current) return false;

  const startedMs = Date.parse(current.startedAt);
  const calculatedDuration = Number.isFinite(startedMs)
    ? Math.max(0, Date.now() - startedMs)
    : null;
  const event = normalizeRoutingEvent({
    kind: "attempt",
    record: normalizeAttemptInput({
      ...patch,
      attemptId,
      completedAt: patch.completedAt || new Date().toISOString(),
      durationMs: patch.durationMs === undefined ? calculatedDuration : patch.durationMs,
      outcome: patch.outcome === undefined ? "unknown" : patch.outcome,
    }, current),
  });
  if (!event) return false;
  return !!(await dbWriteEvent(db, event))?.changed;
}

/**
 * Normalize a report range using strict ISO date/calendar parsing.
 * Date-only values represent UTC midnight. Datetimes require a timezone so a
 * report cannot silently depend on the host's local timezone.
 */
export function normalizeReportRange(range = {}) {
  if (!range || typeof range !== "object" || Array.isArray(range)) {
    throw new RangeError("Invalid date range");
  }
  const explicitStart = parseOptionalDate(range.startDate, "startDate");
  const explicitEnd = parseOptionalDate(range.endDate, "endDate");
  const endMs = explicitEnd ?? Date.now();
  const startMs = explicitStart ?? endMs - DEFAULT_REPORT_DAYS * 86400_000;
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs > endMs) {
    throw new RangeError("Invalid date range");
  }
  if (endMs - startMs > MAX_REPORT_DAYS * 86400_000) {
    throw new RangeError(`Date range must not exceed ${MAX_REPORT_DAYS} days`);
  }
  return {
    start: new Date(startMs).toISOString(),
    end: new Date(endMs).toISOString(),
  };
}

export function percentile(values, p) {
  if (!Array.isArray(values) || values.length === 0) return null;
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1));
  return sorted[index];
}

function roleBreakdown(rows, role) {
  return rows.filter((row) => row.role === role);
}

function sumRows(rows) {
  return rows.reduce((sum, row) => sum + normalizeCount(row.count), 0);
}

function bounded(rows) {
  return rows.slice(0, MAX_REPORT_GROUPS);
}

function fallbackSummary(rows) {
  const counts = new Map();
  for (const row of rows) {
    const reason = normalizeReason(row.fallbackReason);
    if (!reason) continue;
    counts.set(reason, (counts.get(reason) || 0) + normalizeCount(row.count));
  }
  return bounded([...counts.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason)));
}

function publicRequestGroups(rows) {
  return bounded(rows.map((row) => ({
    role: normalizeRole(row.role),
    originalModel: text(row.originalModel),
    strategy: normalizeStrategy(row.strategy),
    outcome: normalizeOutcome(row.outcome),
    count: normalizeCount(row.count),
  })));
}

function publicAttemptGroups(rows) {
  return bounded(rows.map((row) => ({
    role: normalizeRole(row.role),
    provider: text(row.provider, 96),
    model: text(row.model),
    connectionId: normalizeId(row.connectionId),
    outcome: normalizeOutcome(row.outcome),
    fallbackReason: normalizeReason(row.fallbackReason),
    count: normalizeCount(row.count),
    avgDurationMs: Number.isFinite(Number(row.avgDurationMs)) ? Math.max(0, Number(row.avgDurationMs)) : null,
    avgTtftMs: Number.isFinite(Number(row.avgTtftMs)) ? Math.max(0, Number(row.avgTtftMs)) : null,
  })));
}

function publicOutcomeGroups(rows) {
  return bounded(rows.map((row) => ({
    role: normalizeRole(row.role),
    outcome: normalizeOutcome(row.outcome),
    count: normalizeCount(row.count),
  })));
}

function publicDimensionGroups(rows, key) {
  // Dimension reports are aggregate totals, not a top-N sample. Keep the
  // bounded top-N presentation only for the verbose request/attempt detail
  // groups; truncating a provider/model/account here makes the totals lie.
  return rows.map((row) => ({
    [key]: text(row.dimension) || "unknown",
    role: normalizeRole(row.role),
    total: normalizeCount(row.total),
    validTerminal: normalizeCount(row.validTerminal),
    failed: normalizeCount(row.failed),
    cancelled: normalizeCount(row.cancelled),
    incomplete: normalizeCount(row.incomplete),
    unknown: normalizeCount(row.unknown),
  }));
}

function dimensionSql(column) {
  const dimension = `COALESCE(${column}, 'unknown')`;
  return `
    SELECT role, ${dimension} AS dimension, COUNT(*) AS total,
      SUM(CASE WHEN outcome = 'valid_terminal' THEN 1 ELSE 0 END) AS validTerminal,
      SUM(CASE WHEN outcome = 'failed' THEN 1 ELSE 0 END) AS failed,
      SUM(CASE WHEN outcome = 'cancelled' THEN 1 ELSE 0 END) AS cancelled,
      SUM(CASE WHEN outcome = 'incomplete' THEN 1 ELSE 0 END) AS incomplete,
      SUM(CASE WHEN outcome = 'unknown' THEN 1 ELSE 0 END) AS unknown
    FROM routingAttempts
    WHERE startedAt >= ? AND startedAt <= ?
    GROUP BY role, ${dimension}
    ORDER BY total DESC, role ASC, dimension ASC`;
}

function fallbackSql() {
  return `
    SELECT fallbackReason AS reason, COUNT(*) AS count
    FROM routingAttempts
    WHERE role = 'primary' AND startedAt >= ? AND startedAt <= ?
      AND fallbackReason IS NOT NULL
    GROUP BY fallbackReason
    ORDER BY count DESC, reason ASC`;
}

async function getFullDimensionGroups(db, start, end, column, key) {
  const rows = db.all(dimensionSql(column), [start, end]);
  return publicDimensionGroups(rows, key);
}

async function getFullFallbackSummary(db, start, end) {
  return bounded(db.all(fallbackSql(), [start, end]).map((row) => ({
    reason: normalizeReason(row.reason),
    count: normalizeCount(row.count),
  })));
}

export async function getRoutingOutcomes(range = {}) {
  const db = await getAdapter();
  const { start, end } = normalizeReportRange(range);
  const requestRows = db.all(
    `SELECT role, originalModel, strategy, outcome, COUNT(*) AS count
       FROM routingRequests
      WHERE startedAt >= ? AND startedAt <= ?
      GROUP BY role, originalModel, strategy, outcome
      ORDER BY count DESC, role ASC, originalModel ASC, outcome ASC
      LIMIT ?`,
    [start, end, MAX_REPORT_GROUPS * 8],
  );
  const attemptRows = db.all(
    `SELECT role, provider, model, connectionId, outcome, fallbackReason,
            COUNT(*) AS count, AVG(durationMs) AS avgDurationMs, AVG(ttftMs) AS avgTtftMs
       FROM routingAttempts
      WHERE startedAt >= ? AND startedAt <= ?
      GROUP BY role, provider, model, connectionId, outcome, fallbackReason
      ORDER BY count DESC, role ASC, provider ASC, model ASC, connectionId ASC, outcome ASC
      LIMIT ?`,
    [start, end, MAX_REPORT_GROUPS * 8],
  );

  const requestSummary = db.all(
    `SELECT role, outcome, COUNT(*) AS count
       FROM routingRequests WHERE startedAt >= ? AND startedAt <= ?
      GROUP BY role, outcome`,
    [start, end],
  );
  const attemptSummary = db.all(
    `SELECT role, outcome, COUNT(*) AS count
       FROM routingAttempts WHERE startedAt >= ? AND startedAt <= ?
      GROUP BY role, outcome`,
    [start, end],
  );
  const primaryRequestSummary = roleBreakdown(requestSummary, "primary");
  const auxiliaryRequestSummary = requestSummary.filter((row) => row.role !== "primary");
  const primaryAttemptSummary = roleBreakdown(attemptSummary, "primary");
  const auxiliaryAttemptSummary = attemptSummary.filter((row) => row.role !== "primary");
  const requestTotal = sumRows(primaryRequestSummary);
  const requestValid = sumRows(primaryRequestSummary.filter((row) => row.outcome === "valid_terminal"));
  const attemptTotal = sumRows(primaryAttemptSummary);
  const attemptValid = sumRows(primaryAttemptSummary.filter((row) => row.outcome === "valid_terminal"));

  const eligible = normalizeCount(db.get(
    `SELECT COUNT(*) AS count FROM routingAttempts
      WHERE role = 'primary' AND startedAt >= ? AND startedAt <= ?
        AND durationMs IS NOT NULL AND durationMs >= 0`,
    [start, end],
  )?.count);
  const sampledRows = db.all(
    `SELECT durationMs FROM routingAttempts
      WHERE role = 'primary' AND startedAt >= ? AND startedAt <= ?
        AND durationMs IS NOT NULL AND durationMs >= 0
      ORDER BY startedAt DESC, attemptId DESC
      LIMIT ?`,
    [start, end, MAX_LATENCY_SAMPLE],
  );
  const durations = sampledRows.map((row) => Number(row.durationMs)).filter(Number.isFinite);
  const primaryRequestRows = roleBreakdown(requestRows, "primary");
  const auxiliaryRequestRows = requestRows.filter((row) => row.role !== "primary");
  const primaryAttemptRows = roleBreakdown(attemptRows, "primary");
  const auxiliaryAttemptRows = attemptRows.filter((row) => row.role !== "primary");
  const requestGroups = publicRequestGroups(primaryRequestRows);
  const auxiliaryRequestGroups = publicRequestGroups(auxiliaryRequestRows);
  const attemptGroups = publicAttemptGroups(primaryAttemptRows);
  const auxiliaryAttemptGroups = publicAttemptGroups(auxiliaryAttemptRows);
  const byProvider = await getFullDimensionGroups(db, start, end, "provider", "provider");
  const byModel = await getFullDimensionGroups(db, start, end, "model", "model");
  const byConnection = await getFullDimensionGroups(db, start, end, "connectionId", "connectionId");
  const fallbackSummary = await getFullFallbackSummary(db, start, end);

  return {
    window: { startDate: start, endDate: end, maxDays: MAX_REPORT_DAYS },
    requestSuccessRate: requestTotal ? requestValid / requestTotal : 0,
    attemptSuccessRate: attemptTotal ? attemptValid / attemptTotal : 0,
    requests: {
      total: requestTotal,
      validTerminal: requestValid,
      byOutcome: requestGroups,
      primary: { total: requestTotal, validTerminal: requestValid, byOutcome: publicOutcomeGroups(primaryRequestSummary) },
      auxiliary: { total: sumRows(auxiliaryRequestSummary), byOutcome: publicOutcomeGroups(auxiliaryRequestSummary) },
    },
    attempts: {
      total: attemptTotal,
      validTerminal: attemptValid,
      byOutcome: attemptGroups,
      primary: { total: attemptTotal, validTerminal: attemptValid, byOutcome: publicOutcomeGroups(primaryAttemptSummary) },
      auxiliary: { total: sumRows(auxiliaryAttemptSummary), byOutcome: publicOutcomeGroups(auxiliaryAttemptSummary) },
      byProvider,
      byModel,
      byConnection,
      fallbackSummary,
    },
    auxiliary: {
      requests: { total: sumRows(auxiliaryRequestSummary), byOutcome: publicOutcomeGroups(auxiliaryRequestSummary) },
      attempts: { total: sumRows(auxiliaryAttemptSummary), byOutcome: publicOutcomeGroups(auxiliaryAttemptSummary) },
    },
    latency: {
      sampleCount: durations.length,
      eligibleCount: eligible,
      sampled: eligible > durations.length,
      sampleMax: MAX_LATENCY_SAMPLE,
      sampleStrategy: REPORT_SAMPLE_STRATEGY,
      p50DurationMs: percentile(durations, 0.5),
      p95DurationMs: percentile(durations, 0.95),
    },
  };
}

// Keep this separate from the public function name so the return object can
// use the unambiguous `fallbackSummary` key while preserving deterministic
// ordering and bounded output.
function fallbackSummaryRows(rows) {
  return fallbackSummary(rows);
}

export const __test__ = {
  parseStrictIsoDate,
  isValidCalendarDate,
  normalizeReportRange,
  percentile,
  fallbackSummary,
};
