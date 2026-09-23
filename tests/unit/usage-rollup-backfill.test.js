import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  backfillRollup,
  rollupNeedsBackfill,
  rollupDateKeys,
  ensureRollupTable,
  applyEventToRollup,
  ROLLUP_TABLE,
} from "../../runtime/usage-rollup.mjs";
import { runRollupAggregation } from "../../runtime/usage-rollup-read.mjs";
import { runAggregation } from "../../runtime/usage-aggregate.mjs";

/**
 * The backfill exists for one reason: the rollup only accumulates from the
 * moment its writer starts, so an instance upgraded from a build without it has
 * every historical day missing. Wiring the board to the rollup on such an
 * instance would render every past period empty.
 *
 * The property that matters: after a backfill, the rollup read agrees with the
 * raw aggregation over the SAME rows — including days the live writer already
 * wrote, which must NOT be double-counted.
 */

function makeEvent(overrides = {}) {
  return {
    requestId: overrides.requestId || `req-${Math.random().toString(36).slice(2, 10)}`,
    timestamp: `${overrides.day || "2026-09-20"}T10:00:00.000Z`,
    startedAt: `${overrides.day || "2026-09-20"}T10:00:00.000Z`,
    completedAt: `${overrides.day || "2026-09-20"}T10:00:05.000Z`,
    provider: "codex",
    model: "gpt-5.6-sol",
    connectionId: "conn-1",
    apiKeyId: "key-1",
    endpoint: "/v1/chat/completions",
    promptTokens: 1000,
    completionTokens: 50,
    cost: 0.01,
    status: "success",
    tokens: JSON.stringify({ prompt_tokens: 1000, completion_tokens: 50, cached_tokens: 200 }),
    meta: JSON.stringify({ sourceIp: "1.2.3.4", userAgent: "claude-code/1.0" }),
    ...overrides,
  };
}

/** A DB with usageHistory + an (empty) rollup, holding the given events. */
function makeDb(events) {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE usageHistory (
    id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT, provider TEXT, model TEXT,
    connectionId TEXT, apiKey TEXT, apiKeyId TEXT, requestId TEXT, trafficRequestId TEXT,
    startedAt TEXT, completedAt TEXT, endpoint TEXT, promptTokens INTEGER, completionTokens INTEGER,
    cost REAL, status TEXT, tokens TEXT, meta TEXT)`);
  db.exec(`CREATE TABLE networkTraffic (id INTEGER PRIMARY KEY AUTOINCREMENT, requestId TEXT UNIQUE,
    timestamp TEXT, completedAt TEXT, method TEXT, endpoint TEXT, statusCode INTEGER,
    requestBytes INTEGER, responseBytes INTEGER, durationMs INTEGER, aborted INTEGER, meta TEXT)`);
  const insert = db.prepare(
    `INSERT INTO usageHistory(timestamp, provider, model, connectionId, apiKeyId, requestId, startedAt, completedAt, endpoint, promptTokens, completionTokens, cost, status, tokens, meta)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const e of events) {
    insert.run(e.timestamp, e.provider, e.model, e.connectionId, e.apiKeyId, e.requestId, e.startedAt, e.completedAt,
      e.endpoint, e.promptTokens, e.completionTokens, e.cost, e.status, e.tokens, e.meta);
  }
  ensureRollupTable(db);
  return db;
}

const adapterOf = (db) => ({
  all: (sql, p = []) => db.prepare(sql).all(...p),
  get: (sql, p = []) => db.prepare(sql).get(...p),
  iterate: (sql, p = []) => db.prepare(sql).iterate(...p),
  run: (sql, p = []) => db.prepare(sql).run(...p),
  exec: (sql) => db.exec(sql),
});
const maps = { connectionMap: {}, apiKeyMap: {}, providerNodeNameMap: {}, sourceCapture: {} };

function rawStats(db) {
  return runAggregation(adapterOf(db), { period: "all", range: {}, ...maps, now: new Date("2026-09-21T00:00:00Z") });
}

const DIMENSIONS = ["byProvider", "byModel", "byAccount", "byApiKey", "byEndpoint", "bySourceIp", "byApp"];

function totalsOf(map) {
  const buckets = Object.values(map || {});
  return {
    requests: buckets.reduce((s, b) => s + (b.requests || 0), 0),
    cost: buckets.reduce((s, b) => s + (b.cost || 0), 0),
  };
}

describe("rollup backfill", () => {
  it("fills every historical day so the rollup read matches the raw aggregation", async () => {
    const events = [
      makeEvent({ requestId: "a", day: "2026-09-01" }),
      makeEvent({ requestId: "b", day: "2026-09-01", model: "gpt-5.6-terra", cost: 0.02 }),
      makeEvent({ requestId: "c", day: "2026-09-15", provider: "deepseek", model: "deepseek-v4-flash" }),
      makeEvent({ requestId: "d", day: "2026-09-20", status: "error" }),
    ];
    const db = makeDb(events);

    expect(rollupNeedsBackfill(db)).toBe(true);
    const result = await backfillRollup(adapterOf(db));
    expect(result.days).toBe(3);
    expect(rollupNeedsBackfill(db)).toBe(false);

    const rolled = runRollupAggregation(adapterOf(db), { period: "all", range: {}, ...maps, now: new Date("2026-09-21T00:00:00Z") });
    const raw = rawStats(db);
    for (const dim of DIMENSIONS) {
      expect(totalsOf(rolled[dim]).requests, `${dim} requests`).toBe(totalsOf(raw[dim]).requests);
      expect(totalsOf(rolled[dim]).cost, `${dim} cost`).toBeCloseTo(totalsOf(raw[dim]).cost, 9);
    }
    expect(rolled.totalRequests).toBe(raw.totalRequests);
    expect(rolled.completedRequests).toBe(raw.completedRequests);
    expect(rolled.failedRequests).toBe(raw.failedRequests);
    db.close();
  });

  it("does not double-count a day the live writer already owns", async () => {
    // The writer accumulated 2026-09-20; a backfill must leave that day alone,
    // or its counters would be counted twice (the INSERT accumulates).
    const events = [
      makeEvent({ requestId: "old", day: "2026-09-01" }),
      makeEvent({ requestId: "live", day: "2026-09-20" }),
    ];
    const db = makeDb(events);
    applyEventToRollup(db, events[1]); // simulate the live writer

    const result = await backfillRollup(adapterOf(db));
    expect(result.days).toBe(1);          // only 09-01 was filled
    expect(result.skippedDays).toBe(1);   // 09-20 was already present

    const rolled = runRollupAggregation(adapterOf(db), { period: "all", range: {}, ...maps, now: new Date("2026-09-21T00:00:00Z") });
    const raw = rawStats(db);
    expect(rolled.totalRequests).toBe(raw.totalRequests);
    expect(rolled.totalRequests).toBe(2);
    db.close();
  });

  it("is idempotent — a second run adds nothing", async () => {
    const db = makeDb([makeEvent({ requestId: "a", day: "2026-09-10" }), makeEvent({ requestId: "b", day: "2026-09-11" })]);
    await backfillRollup(adapterOf(db));
    const after1 = db.prepare(`SELECT SUM(requests) n FROM ${ROLLUP_TABLE} WHERE dimension='provider'`).get().n;

    const second = await backfillRollup(adapterOf(db));
    expect(second.days).toBe(0);
    expect(second.applied).toBe(0);
    const after2 = db.prepare(`SELECT SUM(requests) n FROM ${ROLLUP_TABLE} WHERE dimension='provider'`).get().n;
    expect(after2).toBe(after1);
    expect(after2).toBe(2);
    db.close();
  });

  it("reports no backfill needed when the rollup is current", async () => {
    const db = makeDb([makeEvent({ requestId: "a", day: "2026-09-20" })]);
    applyEventToRollup(db, { ...makeEvent({ requestId: "a", day: "2026-09-20" }) });
    expect(rollupNeedsBackfill(db)).toBe(false);
    expect(rollupDateKeys(db).has("2026-09-20")).toBe(true);
    db.close();
  });

  it("calls onYield at each batch boundary", async () => {
    const events = Array.from({ length: 12 }, (_, i) => makeEvent({ requestId: `r${i}`, day: "2026-09-05" }));
    const db = makeDb(events);
    let yields = 0;
    await backfillRollup(adapterOf(db), { batchEvents: 5, onYield: async () => { yields++; } });
    // 12 events at a batch of 5 → commits after 5 and 10, plus the final flush.
    expect(yields).toBe(2);
    db.close();
  });
});
