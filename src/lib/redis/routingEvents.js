// Producer for routing request/attempt telemetry.
//
// Routing telemetry is a best-effort observation of a request fan-out. It is
// deliberately independent of the usage/billing/quota path:
//   - it never opens, migrates, or writes SQLite;
//   - it never touches the usage queue or lifetime counters;
//   - every failure is swallowed (fail-open) and surfaced only through the
//     process-local drop/error counters returned by getRoutingTelemetryHealth.
//
// Events are enqueued on the shared routing Redis client (routingClient.js),
// which the durable writer (runtime/routing-writer.mjs) consumes from the
// spring-mouse:routing:events stream:
//   { version: 1, entity: "request"|"attempt", action: "upsert"|"complete", record: {...} }
//
// Callers do not build that envelope by hand. For a chat lifecycle, create a
// process-local context with createRoutingTelemetryContext() and use its
// fire-and-forget helpers; for one-off events use enqueueRoutingEvent() or the
// entity-specific wrappers.
//
// Redaction: every record is normalized through the shared helper before it is
// queued. The helper is authoritative — it keeps only known columns, clamps
// enum fields (outcome/role/strategy/terminalReason) to fixed values, and keeps
// only allowlisted metadata keys. Prompts, messages, tool arguments, auth
// headers, cookies and raw upstream error text therefore have no path into the
// stream, and arbitrary terminal reasons collapse to "unknown".

import { randomUUID } from "node:crypto";
import { routingRedis, getRoutingRedisStatus } from "./routingClient.js";
import {
  ROUTING_STREAM_KEY,
  ROUTING_OUTCOMES,
  ROUTING_ROLES,
  ROUTING_STRATEGIES,
  ROUTING_TERMINAL_REASONS,
  ROUTING_META_KEYS,
  normalizeRoutingEvent,
} from "@/shared/utils/routingTelemetry.js";

export const ROUTING_EVENT_VERSION = 1;
export const ROUTING_ENTITY_REQUEST = "request";
export const ROUTING_ENTITY_ATTEMPT = "attempt";
export const ROUTING_ACTION_UPSERT = "upsert";
export const ROUTING_ACTION_COMPLETE = "complete";

// Re-exported so producers/tests can name the stream without reaching into the
// shared helper. It is the same key the durable writer consumes.
export { ROUTING_STREAM_KEY };

export const ROUTING_ENTITIES = Object.freeze([ROUTING_ENTITY_REQUEST, ROUTING_ENTITY_ATTEMPT]);
export const ROUTING_ACTIONS = Object.freeze([ROUTING_ACTION_UPSERT, ROUTING_ACTION_COMPLETE]);

// Enum/meta allowlists are exported so producers can validate before enqueue and
// callers/tests can reason about what survives normalization.
export const ROUTING_ALLOWED_OUTCOMES = ROUTING_OUTCOMES;
export const ROUTING_ALLOWED_ROLES = ROUTING_ROLES;
export const ROUTING_ALLOWED_STRATEGIES = ROUTING_STRATEGIES;
export const ROUTING_ALLOWED_TERMINAL_REASONS = ROUTING_TERMINAL_REASONS;
export const ROUTING_ALLOWED_META_KEYS = ROUTING_META_KEYS;

const ENTITY_SET = new Set(ROUTING_ENTITIES);
const ACTION_SET = new Set(ROUTING_ACTIONS);

// Mirrors the shared helper's identifier rule so the context can mint ids that
// are guaranteed to survive normalization.
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

function validId(value) {
  return typeof value === "string" && ID_PATTERN.test(value) ? value : null;
}

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function positive(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const DEFAULT_QUEUE_LIMIT = positive(process.env.SPRING_MOUSE_ROUTING_QUEUE_LIMIT, 1000);
const DEFAULT_IN_FLIGHT_LIMIT = positive(process.env.SPRING_MOUSE_ROUTING_INFLIGHT_LIMIT, 8);

// One bounded, process-local queue per Node process. globalThis keeps the state
// shared across HMR/module reloads so counters and the queue cannot silently
// fork into duplicates.
const state = globalThis.__smRoutingEvents ||= {
  queue: [],
  inFlight: 0,
  queueLimit: DEFAULT_QUEUE_LIMIT,
  inFlightLimit: DEFAULT_IN_FLIGHT_LIMIT,
  enqueued: 0,
  sent: 0,
  failed: 0,
  droppedQueueFull: 0,
  droppedInvalid: 0,
  errors: 0,
  maxQueued: 0,
  maxInFlight: 0,
  lastSentAt: 0,
  lastErrorAt: 0,
};

let draining = false;

function queueLimit() {
  return state.queueLimit > 0 ? state.queueLimit : DEFAULT_QUEUE_LIMIT;
}

function inFlightLimit() {
  return state.inFlightLimit > 0 ? state.inFlightLimit : DEFAULT_IN_FLIGHT_LIMIT;
}

/**
 * Normalize a caller record through the shared helper. Returns the sanitized
 * record (never the envelope) or null when the event is not representable —
 * unknown kind, missing/overlong id, or a non-object record.
 *
 * This is the single redaction boundary: only helper columns and allowlisted
 * meta keys survive, and enum fields are clamped.
 */
function sanitizeRecord(entity, input) {
  if (!isPlainObject(input)) return null;
  try {
    const normalized = normalizeRoutingEvent({ kind: entity, record: input });
    const record = normalized?.record;
    if (!record || typeof record.routingRequestId !== "string" || !record.routingRequestId) return null;
    return record;
  } catch {
    // The helper is pure and should not throw; if it ever does, drop the event
    // rather than risk emitting an unnormalized record.
    return null;
  }
}

function scheduleDrain() {
  if (draining) return;
  draining = true;
  // Fire-and-forget: the caller must never await delivery.
  void drain();
}

async function drain() {
  try {
    while (state.queue.length && state.inFlight < inFlightLimit()) {
      const envelope = state.queue.shift();
      state.inFlight++;
      if (state.inFlight > state.maxInFlight) state.maxInFlight = state.inFlight;
      void deliver(envelope);
    }
  } catch {
    state.errors++;
  } finally {
    draining = false;
    // A slot may have freed (or an error thrown) between the loop check and
    // here. Re-arm only when there is genuinely room, so a full in-flight set
    // cannot spin.
    if (state.queue.length && state.inFlight < inFlightLimit()) scheduleDrain();
  }
}

async function deliver(envelope) {
  try {
    const result = await routingRedis((client) =>
      client.xAdd(ROUTING_STREAM_KEY, "*", { event: JSON.stringify(envelope) }),
    );
    if (result === null || result === undefined) {
      // routingRedis returns null when Redis is unconfigured/unavailable or the
      // bounded operation timed out. Count it; never retry a mutation here.
      state.failed++;
    } else {
      state.sent++;
      state.lastSentAt = Date.now();
    }
  } catch {
    // routingRedis already fails open; this is belt-and-braces. The error text
    // is intentionally not recorded or logged.
    state.failed++;
    state.errors++;
    state.lastErrorAt = Date.now();
  } finally {
    if (state.inFlight > 0) state.inFlight--;
    scheduleDrain();
  }
}

/**
 * Enqueue one routing telemetry event. Synchronous and fail-open: it returns
 * whether the event was accepted for delivery and never throws and never awaits.
 *
 * Note: the shared helper requires an `attemptId` on attempt records and a
 * `routingRequestId` on request records; an event missing its id is dropped
 * (counted in `droppedInvalid`), not minted here. Use
 * createRoutingTelemetryContext() to have ids minted for you.
 *
 * @param {"request"|"attempt"} entity
 * @param {"upsert"|"complete"} action
 * @param {object} record caller record (normalized/redacted before enqueue)
 * @returns {boolean} true when queued, false when rejected or dropped
 */
export function enqueueRoutingEvent(entity, action, record) {
  try {
    if (!ENTITY_SET.has(entity)) return false;
    if (!ACTION_SET.has(action)) return false;

    const sanitized = sanitizeRecord(entity, record);
    if (!sanitized) {
      state.droppedInvalid++;
      return false;
    }

    if (state.queue.length >= queueLimit()) {
      // Bounded queue: drop the newest event instead of growing without limit.
      state.droppedQueueFull++;
      return false;
    }

    state.queue.push({
      version: ROUTING_EVENT_VERSION,
      entity,
      action,
      record: sanitized,
    });
    state.enqueued++;
    if (state.queue.length > state.maxQueued) state.maxQueued = state.queue.length;

    scheduleDrain();
    return true;
  } catch {
    state.errors++;
    return false;
  }
}

/** Enqueue a request event. See enqueueRoutingEvent. */
export function enqueueRoutingRequest(action, record) {
  return enqueueRoutingEvent(ROUTING_ENTITY_REQUEST, action, record);
}

/** Enqueue an attempt event. See enqueueRoutingEvent. */
export function enqueueRoutingAttempt(action, record) {
  return enqueueRoutingEvent(ROUTING_ENTITY_ATTEMPT, action, record);
}

/** Enqueue a terminal request snapshot (action: "complete"). */
export function completeRoutingRequest(record) {
  return enqueueRoutingEvent(ROUTING_ENTITY_REQUEST, ROUTING_ACTION_COMPLETE, record);
}

/** Enqueue a terminal attempt snapshot (action: "complete"). */
export function completeRoutingAttempt(record) {
  return enqueueRoutingEvent(ROUTING_ENTITY_ATTEMPT, ROUTING_ACTION_COMPLETE, record);
}

/**
 * Create a process-local telemetry context for one routing request.
 *
 * The context owns the shared routingRequestId (and an optional modelCallId),
 * merges them into every event, mints attempt ids, and exposes bounded
 * fire-and-forget helpers so callers never build an envelope by hand:
 *
 *   const telemetry = createRoutingTelemetryContext({ modelCallId, role, endpoint });
 *   telemetry.upsertRequest({ originalModel, comboName, strategy });
 *   const attemptId = telemetry.upsertAttempt({ provider, model, routeIndex });
 *   telemetry.completeAttempt({ attemptId, outcome: "valid_terminal", terminalReason: "terminal", upstreamStatus: 200 });
 *   telemetry.completeRequest({ outcome: "valid_terminal", attemptCount: 2 });
 *
 * Every method is synchronous, fail-open and never throws. `upsertAttempt`
 * returns the attempt id that must be passed back to `completeAttempt`
 * (attempts require an id; an omitted id is dropped, not minted).
 */
export function createRoutingTelemetryContext(base = {}) {
  const seed = isPlainObject(base) ? base : {};
  const routingRequestId = validId(seed.routingRequestId) || randomUUID();
  const modelCallId = validId(seed.modelCallId) || null;
  const startedAt = typeof seed.startedAt === "string" && seed.startedAt ? seed.startedAt : new Date().toISOString();

  // Identity fields the context guarantees on every event, even if a later
  // record tries to override them.
  const identity = { routingRequestId, modelCallId, startedAt };

  const merge = (record, { terminal = false } = {}) => {
    const input = { ...seed, ...identity, ...(isPlainObject(record) ? record : {}) };
    input.routingRequestId = routingRequestId;
    if (modelCallId) input.modelCallId = modelCallId;
    if (!input.startedAt) input.startedAt = startedAt;
    if (terminal && !input.completedAt) input.completedAt = new Date().toISOString();
    return input;
  };

  const seenAttempts = new Set();

  return {
    routingRequestId,
    modelCallId,

    /** Number of distinct attempts observed by this context. */
    get attemptCount() {
      return seenAttempts.size;
    },

    /** Fire-and-forget request upsert (start / progress snapshot). */
    upsertRequest(record) {
      return enqueueRoutingEvent(ROUTING_ENTITY_REQUEST, ROUTING_ACTION_UPSERT, merge(record));
    },

    /** Fire-and-forget terminal request snapshot. */
    completeRequest(record) {
      return enqueueRoutingEvent(ROUTING_ENTITY_REQUEST, ROUTING_ACTION_COMPLETE, merge(record, { terminal: true }));
    },

    /**
     * Fire-and-forget attempt upsert. Mints the attempt id when the caller does
     * not supply one and returns it (or null when the event was dropped).
     */
    upsertAttempt(record) {
      const source = isPlainObject(record) ? record : {};
      const attemptId = validId(source.attemptId) || randomUUID();
      const merged = merge({ ...source, attemptId });
      const accepted = enqueueRoutingEvent(ROUTING_ENTITY_ATTEMPT, ROUTING_ACTION_UPSERT, merged);
      if (accepted) seenAttempts.add(attemptId);
      return accepted ? attemptId : null;
    },

    /**
     * Fire-and-forget terminal attempt snapshot. Requires the attemptId returned
     * by upsertAttempt; an omitted id is dropped by normalization rather than
     * creating a duplicate row.
     */
    completeAttempt(record) {
      const source = isPlainObject(record) ? record : {};
      const attemptId = validId(source.attemptId);
      const merged = merge({ ...source, ...(attemptId ? { attemptId } : {}) }, { terminal: true });
      const accepted = enqueueRoutingEvent(ROUTING_ENTITY_ATTEMPT, ROUTING_ACTION_COMPLETE, merged);
      if (accepted && attemptId) seenAttempts.add(attemptId);
      return accepted;
    },
  };
}

/**
 * Process-local producer health. Read by the dashboard report route via dynamic
 * import; safe to call when Redis is disabled. It describes only this process —
 * never fleet-wide state — and contains no event contents.
 */
export function getRoutingTelemetryHealth() {
  let redis = null;
  try {
    redis = getRoutingRedisStatus();
  } catch {
    redis = null;
  }
  const limit = queueLimit();
  const inFlight = state.inFlight;
  return {
    scope: "process-local",
    version: ROUTING_EVENT_VERSION,
    streamKey: ROUTING_STREAM_KEY,
    // Healthy means "not shedding load": neither the queue nor the in-flight
    // window is saturated. Redis being down is surfaced separately via `redis`
    // and is not itself unhealthy — the producer fails open by design.
    healthy: state.queue.length < limit && inFlight < inFlightLimit(),
    queued: state.queue.length,
    inFlight,
    queueLimit: limit,
    inFlightLimit: inFlightLimit(),
    enqueued: state.enqueued,
    sent: state.sent,
    failed: state.failed,
    droppedQueueFull: state.droppedQueueFull,
    droppedInvalid: state.droppedInvalid,
    errors: state.errors,
    maxQueued: state.maxQueued,
    maxInFlight: state.maxInFlight,
    lastSentAt: state.lastSentAt || null,
    lastErrorAt: state.lastErrorAt || null,
    redis,
  };
}

// Test-only surface. Not used by production code.
export const __test = Object.freeze({
  state,
  sanitizeRecord,
  setLimits({ queueLimit: queue, inFlightLimit: inFlight } = {}) {
    if (queue !== undefined) state.queueLimit = queue;
    if (inFlight !== undefined) state.inFlightLimit = inFlight;
  },
  reset() {
    state.queue.length = 0;
    state.inFlight = 0;
    state.queueLimit = DEFAULT_QUEUE_LIMIT;
    state.inFlightLimit = DEFAULT_IN_FLIGHT_LIMIT;
    state.enqueued = 0;
    state.sent = 0;
    state.failed = 0;
    state.droppedQueueFull = 0;
    state.droppedInvalid = 0;
    state.errors = 0;
    state.maxQueued = 0;
    state.maxInFlight = 0;
    state.lastSentAt = 0;
    state.lastErrorAt = 0;
    draining = false;
  },
});
