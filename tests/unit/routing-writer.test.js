import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  makeRoutingDbAdapter,
  persistRoutingMessages,
  processRoutingTick,
  pruneRoutingRetention,
  routingSchemaReady,
  createRoutingWriter,
  ROUTING_STREAM_GROUP,
  ROUTING_STREAM_KEY,
} from "../../runtime/routing-writer.mjs";
import { writeRoutingEvent } from "../../src/shared/utils/routingTelemetry.js";

const databases = [];

function openDb({ routing = true, billing = false } = {}) {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA busy_timeout = 5000");
  if (routing) {
    db.exec(`
      CREATE TABLE routingRequests (
        routingRequestId TEXT PRIMARY KEY, modelCallId TEXT, trafficRequestId TEXT,
        originalModel TEXT, endpoint TEXT, role TEXT NOT NULL DEFAULT 'primary',
        requestType TEXT, comboName TEXT, strategy TEXT, autoSource TEXT,
        autoLevel TEXT, autoConfidence REAL, startedAt TEXT NOT NULL,
        completedAt TEXT, outcome TEXT NOT NULL DEFAULT 'unknown',
        terminalReason TEXT, attemptCount INTEGER NOT NULL DEFAULT 0,
        meta TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX idx_rr_started_at ON routingRequests(startedAt DESC);
      CREATE TABLE routingAttempts (
        attemptId TEXT PRIMARY KEY, routingRequestId TEXT NOT NULL, modelCallId TEXT,
        role TEXT NOT NULL DEFAULT 'primary', provider TEXT, model TEXT,
        connectionId TEXT, routeIndex INTEGER, candidateIndex INTEGER,
        sourceFormat TEXT, targetFormat TEXT, nativePassthrough INTEGER NOT NULL DEFAULT 0,
        streamMode TEXT, startedAt TEXT NOT NULL, completedAt TEXT,
        upstreamStatus INTEGER, outcome TEXT NOT NULL DEFAULT 'unknown',
        fallbackReason TEXT, terminalReason TEXT, ttftMs INTEGER, durationMs INTEGER,
        promptTokens INTEGER, completionTokens INTEGER, meta TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX idx_ra_started_at ON routingAttempts(startedAt DESC);
    `);
  }
  if (billing) {
    db.exec(`
      CREATE TABLE _meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE usageHistory(id INTEGER PRIMARY KEY AUTOINCREMENT, requestId TEXT);
      INSERT INTO _meta(key, value) VALUES ('totalRequestsLifetime', '17');
      INSERT INTO usageHistory(requestId) VALUES ('billing-1');
    `);
  }
  databases.push(db);
  return db;
}

function requestRecord(overrides = {}) {
  return {
    routingRequestId: "req-1",
    modelCallId: "call-1",
    originalModel: "model-a",
    endpoint: "/v1/chat/completions",
    startedAt: "2026-09-27T00:00:00.000Z",
    outcome: "unknown",
    attemptCount: 1,
    ...overrides,
  };
}

function attemptRecord(overrides = {}) {
  return {
    attemptId: "attempt-1",
    routingRequestId: "req-1",
    provider: "provider-a",
    model: "model-a",
    startedAt: "2026-09-27T00:00:00.000Z",
    outcome: "unknown",
    ...overrides,
  };
}

function envelope(entity, record, action = "upsert") {
  return { version: 1, entity, action, record };
}

function message(id, event) {
  return { id, message: { event: JSON.stringify(event) } };
}

function mockRedis({ replay = [], fresh = [] } = {}) {
  const calls = [];
  return {
    calls,
    async xAutoClaim(...args) {
      calls.push(["xAutoClaim", ...args]);
      return { nextId: "0-0", messages: replay };
    },
    async xReadGroup(...args) {
      calls.push(["xReadGroup", ...args]);
      return fresh.length ? [{ name: ROUTING_STREAM_KEY, messages: fresh }] : [];
    },
    async xAck(...args) { calls.push(["xAck", ...args]); },
    async xDel(...args) { calls.push(["xDel", ...args]); },
  };
}

function count(db, table) {
  return db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count;
}

afterEach(() => {
  while (databases.length) databases.pop().close();
});

describe("routing-writer", () => {
  it("commits one duplicate delivery idempotently and ACKs only after commit", async () => {
    const db = openDb();
    const event = envelope("request", requestRecord());
    const redis = mockRedis({
      replay: [message("1-0", event)],
      fresh: [message("1-0", event)],
    });

    const result = await processRoutingTick({ client: redis, database: db, batchSize: 2 });

    expect(result.committed).toBe(1);
    expect(count(db, "routingRequests")).toBe(1);
    expect(redis.calls.map(([name]) => name)).toEqual([
      "xAutoClaim", "xReadGroup", "xAck", "xDel",
    ]);
    expect(redis.calls[2][3]).toEqual(["1-0"]);
    expect(redis.calls[3][2]).toEqual(["1-0"]);
    expect(redis.calls[1][3]).toEqual([{ key: ROUTING_STREAM_KEY, id: ">" }]);
    expect(redis.calls[1][4]).toEqual({ COUNT: 1 });
    expect(redis.calls[1][3]).not.toHaveProperty("BLOCK");

    // A replay after a lost ACK is safe and does not create another row.
    const replayAgain = mockRedis({ replay: [message("1-0", event)] });
    const second = await processRoutingTick({ client: replayAgain, database: db, batchSize: 2 });
    expect(second.committed).toBe(1);
    expect(count(db, "routingRequests")).toBe(1);
  });

  it("writes request and attempt snapshots in one transaction", () => {
    const db = openDb();
    const adapter = makeRoutingDbAdapter(db);
    const result = persistRoutingMessages(adapter, [
      { id: "1-0", event: envelope("request", requestRecord()) },
      { id: "2-0", event: envelope("attempt", attemptRecord()) },
    ]);

    expect(result).toMatchObject({ committed: true, valid: 2, malformedIds: [] });
    expect(count(db, "routingRequests")).toBe(1);
    expect(count(db, "routingAttempts")).toBe(1);
  });

  it("rolls back the complete batch and leaves messages unacknowledged", async () => {
    const db = openDb();
    const base = makeRoutingDbAdapter(db);
    let runCount = 0;
    const failing = {
      ...base,
      run(sql, params) {
        runCount += 1;
        if (runCount === 2) throw new Error("injected write failure");
        return base.run(sql, params);
      },
      transaction(fn) {
        db.exec("SAVEPOINT test_routing_batch");
        try {
          const result = fn();
          db.exec("RELEASE test_routing_batch");
          return result;
        } catch (error) {
          db.exec("ROLLBACK TO test_routing_batch");
          db.exec("RELEASE test_routing_batch");
          throw error;
        }
      },
    };
    const redis = mockRedis({ fresh: [
      message("1-0", envelope("request", requestRecord({ routingRequestId: "req-1" }))),
      message("2-0", envelope("request", requestRecord({ routingRequestId: "req-2" }))),
    ] });

    const result = await processRoutingTick({ client: redis, database: db, adapter: failing, batchSize: 2 });

    expect(result.skipped).toBe("database-error");
    expect(count(db, "routingRequests")).toBe(0);
    expect(redis.calls.some(([name]) => name === "xAck")).toBe(false);
    expect(redis.calls.some(([name]) => name === "xDel")).toBe(false);
  });

  it("ACKs and deletes malformed envelopes while retaining valid records", async () => {
    const db = openDb();
    const redis = mockRedis({ fresh: [
      message("bad-0", { version: 99, entity: "request", action: "upsert", record: requestRecord() }),
      message("good-0", envelope("request", requestRecord())),
    ] });

    const result = await processRoutingTick({ client: redis, database: db, batchSize: 3 });

    expect(result).toMatchObject({ committed: 1, malformed: 1 });
    expect(count(db, "routingRequests")).toBe(1);
    const acks = redis.calls.filter(([name]) => name === "xAck");
    const dels = redis.calls.filter(([name]) => name === "xDel");
    expect(acks.map(([, , , ids]) => ids)).toEqual([["good-0"], ["bad-0"]]);
    expect(dels.map(([, , ids]) => ids)).toEqual([["good-0"], ["bad-0"]]);
  });

  it("does not touch Redis when telemetry schema is unavailable", async () => {
    const db = openDb({ routing: false });
    const redis = mockRedis({ fresh: [message("1-0", envelope("request", requestRecord()))] });

    expect(routingSchemaReady(makeRoutingDbAdapter(db))).toBe(false);
    const result = await processRoutingTick({ client: redis, database: db });

    expect(result.skipped).toBe("missing-schema");
    expect(redis.calls).toEqual([]);
  });

  it("prunes a fixed 30-day window in bounded chunks", () => {
    const db = openDb();
    const old = new Date(Date.now() - 31 * 86400_000).toISOString();
    const recent = new Date(Date.now() - 2 * 86400_000).toISOString();
    writeRoutingEvent(makeRoutingDbAdapter(db), { kind: "request", record: requestRecord({ routingRequestId: "old-1", startedAt: old }) });
    writeRoutingEvent(makeRoutingDbAdapter(db), { kind: "request", record: requestRecord({ routingRequestId: "old-2", startedAt: old }) });
    writeRoutingEvent(makeRoutingDbAdapter(db), { kind: "request", record: requestRecord({ routingRequestId: "new-1", startedAt: recent }) });
    writeRoutingEvent(makeRoutingDbAdapter(db), { kind: "attempt", record: attemptRecord({ attemptId: "attempt-old-1", startedAt: old }) });
    writeRoutingEvent(makeRoutingDbAdapter(db), { kind: "attempt", record: attemptRecord({ attemptId: "attempt-old-2", startedAt: old }) });
    writeRoutingEvent(makeRoutingDbAdapter(db), { kind: "attempt", record: attemptRecord({ attemptId: "attempt-new-1", startedAt: recent }) });

    const removed = pruneRoutingRetention(db, { now: Date.now(), chunkSize: 1 });

    expect(removed).toBe(2);
    expect(count(db, "routingRequests")).toBe(2);
    expect(count(db, "routingAttempts")).toBe(2);
  });

  it("keeps routing telemetry isolated from billing state", async () => {
    const db = openDb({ billing: true });
    const redis = mockRedis({ fresh: [message("1-0", envelope("request", requestRecord()))] });

    const result = await processRoutingTick({ client: redis, database: db });

    expect(result.committed).toBe(1);
    expect(db.prepare("SELECT value FROM _meta WHERE key = 'totalRequestsLifetime'").get().value).toBe("17");
    expect(count(db, "usageHistory")).toBe(1);
    expect(count(db, "routingRequests")).toBe(1);
  });

  it("runs scheduled retention on an empty tick even when no rows are removed", async () => {
    const db = openDb();
    const redis = mockRedis();
    const writer = createRoutingWriter({
      getDatabase: () => db,
      retentionIntervalMs: 1,
      retentionChunk: 1,
      pollMs: 0,
    });
    const first = await writer.tick(redis, { now: 1000 });
    const second = await writer.tick(redis, { now: 1002 });
    expect(first.retentionRan).toBe(true);
    expect(first.pruned).toBe(0);
    expect(second.retentionRan).toBe(true);
    expect(writer.state.lastRetentionAt).toBe(1002);
  });

  it("restores the actual SQLite busy timeout after a routing write", async () => {
    const db = openDb();
    db.exec("PRAGMA busy_timeout = 4321");
    const redis = mockRedis({ fresh: [message("1-0", envelope("request", requestRecord()))] });
    const result = await processRoutingTick({
      client: redis,
      database: db,
      retention: { busyTimeoutMs: 7, lastAt: Date.now(), intervalMs: 60_000, due: () => false },
    });
    expect(result.committed).toBe(1);
    expect(db.prepare("PRAGMA busy_timeout").get().timeout).toBe(4321);
  });

  it("returns bounded startup/replay errors without throwing", async () => {
    const db = openDb();
    const replayFailure = {
      async xAutoClaim() { throw new Error("redis unavailable"); },
    };
    const result = await processRoutingTick({ client: replayFailure, database: db });
    expect(result.skipped).toBe("redis-replay");
    expect(result.error).toBeInstanceOf(Error);

    const writer = createRoutingWriter({ getDatabase: () => db, pollMs: 0 });
    const groupFailure = { async xGroupCreate() { throw new Error("connection refused"); } };
    await expect(writer.run(groupFailure)).resolves.toBeUndefined();
  });

  it("passes the shared stream group contract", () => {
    expect(ROUTING_STREAM_KEY).toBe("spring-mouse:routing:events");
    expect(ROUTING_STREAM_GROUP).toBe("routing-writers");
  });

});
