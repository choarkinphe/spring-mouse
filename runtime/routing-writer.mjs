/**
 * Durable writer for routing request/attempt telemetry.
 *
 * This queue is deliberately independent of the usage queue.  Routing events are
 * best-effort observations of a request fan-out; they must never hold up billing
 * ingestion, usage rollups, quotas, or lifetime counters.
 *
 * The producer writes a versioned envelope to Redis:
 *   { version: 1, entity: "request"|"attempt", action: "upsert"|"complete", record: {...} }
 *
 * The schema/record validation and monotonic idempotent upsert live in the shared
 * helper.  This module only owns Redis delivery, transaction boundaries, bounded
 * replay, SQLite lock handling, and retention.
 */
import {
  normalizeRoutingEvent,
  writeRoutingEvent,
  ROUTING_STREAM_KEY as SHARED_ROUTING_STREAM_KEY,
  ROUTING_STREAM_GROUP as SHARED_ROUTING_STREAM_GROUP,
} from "../src/shared/utils/routingTelemetry.js";

export const ROUTING_STREAM_KEY = SHARED_ROUTING_STREAM_KEY;
export const ROUTING_STREAM_GROUP = SHARED_ROUTING_STREAM_GROUP;
export const ROUTING_CONSUMER = `routing-writer-${process.env.HOSTNAME || "local"}-${process.pid}`;

const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_POLL_MS = 250;
const DEFAULT_BUSY_TIMEOUT_MS = 250;
const DEFAULT_USAGE_BUSY_TIMEOUT_MS = 5000;
const DEFAULT_RETENTION_DAYS = 30;
const DEFAULT_RETENTION_CHUNK = 500;
const DEFAULT_RETENTION_INTERVAL_MS = 60 * 60 * 1000;
const DEFAULT_ERROR_BACKOFF_MS = 250;
const DEFAULT_MAX_BACKOFF_MS = 5000;
const MAX_REDIS_ERROR_STREAK = 3;

const ROUTING_TABLES = ["routingRequests", "routingAttempts"];

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function nonNegativeInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, Math.max(0, ms));
    timer.unref?.();
  });
}

function redisMessageEvent(message) {
  const value = message?.message?.event ?? message?.message?.data ?? message?.event;
  if (typeof value === "object" && value !== null) return value;
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/**
 * Convert node-redis XREADGROUP/XAUTOCLAIM output to a single message list.
 * Keeping this tolerant is useful for both Redis v4/v5 and small test doubles.
 */
export function normalizeRedisMessages(result) {
  if (!result) return [];
  const streams = Array.isArray(result) ? result : [result];
  const messages = [];
  for (const stream of streams) {
    for (const message of stream?.messages || []) {
      if (message?.id) messages.push({ id: message.id, event: redisMessageEvent(message) });
    }
  }
  return messages;
}

function dbRun(database, sql, params = []) {
  if (typeof database?.run === "function") return database.run(sql, params);
  if (typeof database?.prepare === "function") return database.prepare(sql).run(...params);
  throw new TypeError("routing writer database does not provide run()");
}

function dbGet(database, sql, params = []) {
  if (typeof database?.get === "function") return database.get(sql, params);
  if (typeof database?.prepare === "function") return database.prepare(sql).get(...params);
  throw new TypeError("routing writer database does not provide get()");
}

function dbAll(database, sql, params = []) {
  if (typeof database?.all === "function") return database.all(sql, params);
  if (typeof database?.prepare === "function") return database.prepare(sql).all(...params);
  throw new TypeError("routing writer database does not provide all()");
}

function dbExec(database, sql) {
  if (typeof database?.exec === "function") return database.exec(sql);
  throw new TypeError("routing writer database does not provide exec()");
}

/**
 * Adapt node:sqlite's raw DatabaseSync to the small synchronous DB interface used
 * by the shared telemetry helper. Existing adapters can be passed through as-is.
 */
export function makeRoutingDbAdapter(database) {
  if (!database) return null;
  if (typeof database.run === "function" && typeof database.get === "function") return database;
  if (typeof database.prepare !== "function") return null;
  return {
    run(sql, params = []) { return database.prepare(sql).run(...params); },
    get(sql, params = []) { return database.prepare(sql).get(...params); },
    all(sql, params = []) { return database.prepare(sql).all(...params); },
    exec(sql) { return database.exec(sql); },
    transaction(fn) {
      const savepoint = `routing_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      database.exec(`SAVEPOINT ${savepoint}`);
      try {
        const value = fn();
        database.exec(`RELEASE ${savepoint}`);
        return value;
      } catch (error) {
        try { database.exec(`ROLLBACK TO ${savepoint}`); } catch {}
        try { database.exec(`RELEASE ${savepoint}`); } catch {}
        throw error;
      }
    },
  };
}

function withTransaction(database, fn) {
  if (typeof database?.transaction === "function") return database.transaction(fn);
  if (typeof database?.exec !== "function") return fn();
  dbExec(database, "BEGIN");
  try {
    const value = fn();
    dbExec(database, "COMMIT");
    return value;
  } catch (error) {
    try { dbExec(database, "ROLLBACK"); } catch {}
    throw error;
  }
}

/** Check only for telemetry tables; never run migrations from the worker. */
export function routingSchemaReady(database) {
  if (!database) return false;
  try {
    const rows = dbAll(
      database,
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (?, ?)",
      ROUTING_TABLES,
    );
    const found = new Set(rows.map((row) => row?.name));
    return ROUTING_TABLES.every((name) => found.has(name));
  } catch {
    return false;
  }
}

function setBusyTimeout(database, milliseconds) {
  if (!database || typeof database.exec !== "function") return null;
  try {
    const previous = dbGet(database, "PRAGMA busy_timeout");
    dbExec(database, `PRAGMA busy_timeout = ${Math.max(0, Math.floor(milliseconds))}`);
    return Number(previous?.timeout ?? previous?.busy_timeout ?? previous?.["busy_timeout"] ?? DEFAULT_USAGE_BUSY_TIMEOUT_MS);
  } catch {
    // A mock adapter may not expose PRAGMA reads. Still set the short timeout;
    // restoring to the known usage default in finally is safer than leaving a
    // short timeout on a shared production connection.
    try { dbExec(database, `PRAGMA busy_timeout = ${Math.max(0, Math.floor(milliseconds))}`); } catch {}
    return DEFAULT_USAGE_BUSY_TIMEOUT_MS;
  }
}

function restoreBusyTimeout(database, previous) {
  if (!database || typeof database.exec !== "function") return;
  try { dbExec(database, `PRAGMA busy_timeout = ${Math.max(0, Math.floor(previous ?? DEFAULT_USAGE_BUSY_TIMEOUT_MS))}`); } catch {}
}

function isTransientDatabaseError(error) {
  return /database is locked|database busy|SQLITE_BUSY|SQLITE_LOCKED/i.test(String(error?.message || error));
}

function eventKey(message) {
  return String(message?.id || "");
}

function normalizeStreamEvent(event) {
  if (!event || typeof event !== "object" || Array.isArray(event)) return null;
  // Producers use an explicit envelope so the stream can be inspected without
  // guessing whether a snapshot is a request or an attempt. Only version 1 is
  // accepted; malformed/unknown versions are discarded and ACKed.
  if (event.version !== 1) return null;
  if (event.entity !== "request" && event.entity !== "attempt") return null;
  if (event.action !== "upsert" && event.action !== "complete") return null;
  return normalizeRoutingEvent({ kind: event.entity, record: event.record });
}

export function normalizeRoutingEventEnvelope(event) {
  return normalizeStreamEvent(event);
}

/**
 * Process one bounded message batch. No retry happens here: a failed transaction
 * leaves messages pending so the next bounded XAUTOCLAIM can replay them.
 */
export function persistRoutingMessages(database, messages, options = {}) {
  const adapter = options.adapter || makeRoutingDbAdapter(database) || database;
  const valid = [];
  const malformedIds = [];
  const seen = new Set();

  for (const message of messages || []) {
    const id = eventKey(message);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const event = message?.event;
    let normalized = null;
    try { normalized = event ? normalizeStreamEvent(event) : null; } catch { normalized = null; }
    if (!normalized) {
      if (id) malformedIds.push(id);
      continue;
    }
    // Keep the normalized snapshot, rather than replaying the envelope. This
    // makes the writer compatible with the shared helper's stable { kind, record }
    // write contract while validation still sees the producer's version/action.
    valid.push({ id, event: normalized });
  }

  if (!valid.length) return { committed: false, valid: 0, malformedIds, ids: [] };

  withTransaction(adapter, () => {
    for (const message of valid) {
      const result = writeRoutingEvent(adapter, message.event);
      if (!result) throw new Error("routing telemetry write failed");
    }
  });

  return {
    committed: true,
    valid: valid.length,
    malformedIds,
    ids: valid.map((message) => message.id),
  };
}

async function ackAndDelete(client, ids) {
  if (!ids?.length) return;
  // Do not reorder these. SQLite commit completes before this function is called;
  // ACK first transfers ownership, then DEL removes the durable stream entry.
  await client.xAck(ROUTING_STREAM_KEY, ROUTING_STREAM_GROUP, ids);
  await client.xDel(ROUTING_STREAM_KEY, ids);
}

function retentionResult(database, retention) {
  if (!retention?.due?.()) return { pruned: 0, retentionRan: false };
  const pruned = pruneRoutingRetention(database, { ...retention, now: retention?.now ?? Date.now() });
  return {
    pruned,
    retentionRan: true,
  };
}

function runRetentionBounded(database, retention) {
  const previousBusyTimeout = setBusyTimeout(database, optionsBusyTimeout(retention));
  try {
    return retentionResult(database, retention);
  } finally {
    // Restore the timeout actually configured on this shared connection. Usage
    // may use a different value than the 5s default.
    restoreBusyTimeout(database, previousBusyTimeout);
  }
}

/**
 * One routing tick: one bounded replay claim and one non-blocking new-message
 * read.  A database failure rejects without ACK/DEL, preserving replay.
 */
export async function processRoutingTick({ client, database, adapter, replayCursor = "0-0", batchSize = DEFAULT_BATCH_SIZE, now = Date.now(), retention = null } = {}) {
  if (!client) return { nextReplayCursor: replayCursor, committed: 0, malformed: 0, skipped: "no-client" };
  if (!database && !adapter) return { nextReplayCursor: replayCursor, committed: 0, malformed: 0, skipped: "no-db" };

  const db = database || adapter;
  const dbAdapter = adapter || makeRoutingDbAdapter(database) || database;
  if (!routingSchemaReady(dbAdapter)) {
    return { nextReplayCursor: "0-0", committed: 0, malformed: 0, skipped: "missing-schema" };
  }

  let claimed;
  try {
    claimed = await client.xAutoClaim(
      ROUTING_STREAM_KEY,
      ROUTING_STREAM_GROUP,
      ROUTING_CONSUMER,
      0,
      replayCursor || "0-0",
      { COUNT: batchSize },
    );
  } catch (error) {
    return { nextReplayCursor: "0-0", committed: 0, malformed: 0, skipped: "redis-replay", error };
  }

  const replayMessages = normalizeRedisMessages(claimed).slice(0, batchSize);
  const nextReplayCursor = claimed?.nextId || "0-0";

  let freshResult;
  const freshCount = Math.max(0, batchSize - replayMessages.length);
  if (freshCount > 0) try {
    // Intentionally no BLOCK: routing polling must never occupy the usage
    // consumer's Redis command or event-loop turn. Keep total work per tick
    // bounded even when replay and fresh messages are both available.
    freshResult = await client.xReadGroup(
      ROUTING_STREAM_GROUP,
      ROUTING_CONSUMER,
      [{ key: ROUTING_STREAM_KEY, id: ">" }],
      { COUNT: freshCount },
    );
  } catch (error) {
    // Replay messages remain pending; they are reclaimed on a later tick.
    return { nextReplayCursor, committed: 0, malformed: 0, skipped: "redis-read", error };
  }

  const freshMessages = normalizeRedisMessages(freshResult);
  const messages = [];
  const ids = new Set();
  for (const message of [...replayMessages, ...freshMessages]) {
    if (!message.id || ids.has(message.id)) continue;
    ids.add(message.id);
    messages.push(message);
  }
  if (!messages.length) {
    const retained = runRetentionBounded(db, retention);
    return { nextReplayCursor, committed: 0, malformed: 0, skipped: "empty", ...retained };
  }

  let result;
  const previousBusyTimeout = setBusyTimeout(db, optionsBusyTimeout(retention));
  try {
    result = persistRoutingMessages(db, messages, { adapter: dbAdapter });
  } catch (error) {
    return {
      nextReplayCursor: "0-0",
      committed: 0,
      malformed: 0,
      skipped: isTransientDatabaseError(error) ? "database-busy" : "database-error",
      error,
    };
  } finally {
    // Do not keep the short routing timeout while awaiting Redis ACK/DEL. The
    // usage loop shares this SQLite connection and must regain its normal
    // timeout before another task can run.
    restoreBusyTimeout(db, previousBusyTimeout);
  }

  try {
    // Malformed envelopes are permanently discarded. They cannot become valid
    // on replay, and retaining them would wedge the consumer indefinitely.
    await ackAndDelete(client, result.ids);
    await ackAndDelete(client, result.malformedIds);
  } catch (error) {
    // The DB commit already succeeded. Leave the entries pending if Redis ACK or
    // DEL fails; the bounded XAUTOCLAIM replay will safely upsert them again.
    return { nextReplayCursor: "0-0", committed: result.valid, malformed: 0, skipped: "redis-ack", error };
  }

  const retained = runRetentionBounded(db, retention);
  return { nextReplayCursor, committed: result.valid, malformed: result.malformedIds.length, ...retained };
}

// Kept separate to make the short timeout explicit at the call site and easy to
// override in tests without introducing an unbounded lock wait.
function optionsBusyTimeout(retention) {
  return positiveInt(retention?.busyTimeoutMs, DEFAULT_BUSY_TIMEOUT_MS);
}

function pruneDelete(database, table, cutoff, chunk) {
  const index = table === "routingRequests" ? "idx_rr_started_at" : "idx_ra_started_at";
  const result = dbRun(
    database,
    `DELETE FROM ${table} WHERE rowid IN (
       SELECT rowid FROM ${table} INDEXED BY ${index} WHERE startedAt < ? LIMIT ?
     )`,
    [cutoff, chunk],
  );
  return Number(result?.changes || 0);
}

/** Delete at most one bounded chunk from each routing table. */
export function pruneRoutingRetention(database, options = {}) {
  if (!database || !routingSchemaReady(database)) return 0;
  const days = DEFAULT_RETENTION_DAYS;
  const chunk = positiveInt(options.chunkSize, DEFAULT_RETENTION_CHUNK);
  const now = Number(options.now ?? Date.now());
  const cutoff = new Date(now - days * 86400_000).toISOString();
  let removed = 0;
  for (const table of ROUTING_TABLES) {
    try { removed += pruneDelete(database, table, cutoff, chunk); } catch { /* schema/index may be mid-upgrade */ }
  }
  return removed;
}

function retentionDue(retention, now) {
  return now - Number(retention?.lastAt || 0) >= Number(retention?.intervalMs || DEFAULT_RETENTION_INTERVAL_MS);
}

/**
 * Construct a supervisor which can be driven by usage-writer's independent loop.
 * The loop has bounded polling, bounded replay, and capped error backoff. It does
 * not throw into the usage writer.
 */
export function createRoutingWriter({
  getDatabase,
  getAdapter,
  batchSize = positiveInt(process.env.SPRING_MOUSE_ROUTING_BATCH_SIZE, DEFAULT_BATCH_SIZE),
  pollMs = nonNegativeInt(process.env.SPRING_MOUSE_ROUTING_POLL_MS, DEFAULT_POLL_MS),
  retentionIntervalMs = positiveInt(process.env.SPRING_MOUSE_ROUTING_RETENTION_INTERVAL_MS, DEFAULT_RETENTION_INTERVAL_MS),
  retentionChunk = positiveInt(process.env.SPRING_MOUSE_ROUTING_RETENTION_CHUNK, DEFAULT_RETENTION_CHUNK),
  busyTimeoutMs = positiveInt(process.env.SPRING_MOUSE_ROUTING_BUSY_TIMEOUT_MS, DEFAULT_BUSY_TIMEOUT_MS),
  isStopping = () => false,
  logger = console,
} = {}) {
  const state = {
    replayCursor: "0-0",
    lastRetentionAt: 0,
    backoffMs: DEFAULT_ERROR_BACKOFF_MS,
    stopped: false,
    groupReady: new WeakSet(),
  };

  function resolveDatabase() {
    const database = typeof getDatabase === "function" ? getDatabase() : getDatabase;
    const adapter = typeof getAdapter === "function" ? getAdapter(database) : getAdapter;
    return { database, adapter: adapter || makeRoutingDbAdapter(database) || database };
  }

  async function ensureGroup(client) {
    if (!client) return false;
    // A Redis client is an object and can be weakly keyed; test doubles without
    // object identity simply go through the idempotent BUSYGROUP path each time.
    if (typeof client === "object" && client && state.groupReady.has(client)) return true;
    try {
      await client.xGroupCreate(ROUTING_STREAM_KEY, ROUTING_STREAM_GROUP, "0", { MKSTREAM: true });
    } catch (error) {
      if (!String(error?.message || error).includes("BUSYGROUP")) return false;
    }
    if (typeof client === "object" && client) state.groupReady.add(client);
    return true;
  }

  async function tick(client, options = {}) {
    if (state.stopped || isStopping()) return { skipped: "stopping" };
    const { database, adapter } = resolveDatabase();
    const now = Number(options.now ?? Date.now());
    const retention = {
      busyTimeoutMs,
      chunkSize: retentionChunk,
      lastAt: state.lastRetentionAt,
      intervalMs: retentionIntervalMs,
      now,
      due: () => retentionDue(retention, now),
    };
    const result = await processRoutingTick({ client, database, adapter, replayCursor: state.replayCursor, batchSize, now, retention });
    state.replayCursor = result.nextReplayCursor || "0-0";
    if (result.retentionRan) state.lastRetentionAt = now;
    if (result.skipped && result.skipped !== "empty" && result.skipped !== "missing-schema") {
      state.replayCursor = "0-0";
    }
    return result;
  }

  async function run(client) {
    if (!client) return;
    if (!await ensureGroup(client)) return;
    let redisErrorStreak = 0;
    while (!state.stopped && !isStopping()) {
      try {
        const result = await tick(client);
        if (result?.skipped === "redis-replay" || result?.skipped === "redis-read") {
          // Return control after a short, bounded streak so the supervisor can
          // rebuild the connection instead of spinning on a dead socket.
          redisErrorStreak += 1;
          if (redisErrorStreak >= MAX_REDIS_ERROR_STREAK) return;
          state.backoffMs = Math.min(state.backoffMs * 2, DEFAULT_MAX_BACKOFF_MS);
          await sleep(state.backoffMs);
          continue;
        }
        redisErrorStreak = 0;
        if (result?.skipped === "database-error") {
          state.backoffMs = Math.min(state.backoffMs * 2, DEFAULT_MAX_BACKOFF_MS);
          await sleep(state.backoffMs);
        } else {
          state.backoffMs = DEFAULT_ERROR_BACKOFF_MS;
          await sleep(pollMs);
        }
      } catch (error) {
        // Routing is observability. Never allow an error to terminate or delay
        // usage-writer's billing loop.
        try { logger.warn?.("[RoutingWriter] tick failed:", error?.message || error); } catch {}
        state.replayCursor = "0-0";
        state.backoffMs = Math.min(state.backoffMs * 2, DEFAULT_MAX_BACKOFF_MS);
        await sleep(state.backoffMs);
      }
    }
  }

  function stop() { state.stopped = true; }

  return {
    tick,
    run,
    stop,
    ensureGroup,
    state,
    get replayCursor() { return state.replayCursor; },
  };
}

export const __test = {
  ackAndDelete,
  dbRun,
  dbGet,
  dbAll,
  dbExec,
  withTransaction,
  setBusyTimeout,
  restoreBusyTimeout,
};
