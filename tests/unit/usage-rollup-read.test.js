import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { ensureRollupTable, ROLLUP_TABLE } from "../../runtime/usage-rollup.mjs";
import { runRollupAggregation, resolveDateKeyRange, localDateKey } from "../../runtime/usage-rollup-read.mjs";
import { runAggregation } from "../../runtime/usage-aggregate.mjs";

/**
 * The rollup read path must agree with the raw aggregation on every dimension it
 * serves. That equivalence is the whole point — if it drifts, the board shows
 * different numbers before and after the rollup boundary and nobody can tell
 * which is right.
 *
 * These tests build BOTH from the same event set and compare.
 */

const DAY = "2026-09-20";

function makeEvent(overrides = {}) {
  return {
    requestId: overrides.requestId || `req-${Math.random().toString(36).slice(2, 10)}`,
    timestamp: `${DAY}T10:00:00.000Z`,
    startedAt: `${DAY}T10:00:00.000Z`,
    completedAt: `${DAY}T10:00:05.000Z`,
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

// Build a rollup table from the events, using the same bucket derivation the
// writer uses (imported below so the test tracks the real implementation).
async function buildRollup(events) {
  const { rollupBucketsForEvent } = await import("../../runtime/usage-rollup.mjs");
  const db = new DatabaseSync(":memory:");
  ensureRollupTable(db);
  const ins = db.prepare(
    `INSERT INTO ${ROLLUP_TABLE}(dateKey, dimension, bucketKey, requests, promptTokens, completionTokens, cachedTokens, cost, meta)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(dateKey, dimension, bucketKey) DO UPDATE SET
       requests = requests + excluded.requests,
       promptTokens = promptTokens + excluded.promptTokens,
       completionTokens = completionTokens + excluded.completionTokens,
       cachedTokens = cachedTokens + excluded.cachedTokens,
       cost = cost + excluded.cost`,
  );
  for (const e of events) {
    const dateKey = localDateKey(new Date(e.completedAt || e.timestamp));
    for (const b of rollupBucketsForEvent(e)) {
      const c = b.counters;
      ins.run(dateKey, b.dimension, b.bucketKey, c.requests, c.promptTokens, c.completionTokens, c.cachedTokens, c.cost, JSON.stringify(b.meta || {}));
    }
  }
  return db;
}

function rawStats(events, maps = {}) {
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
  const adapter = {
    all: (sql, p = []) => db.prepare(sql).all(...p),
    get: (sql, p = []) => db.prepare(sql).get(...p),
    iterate: (sql, p = []) => db.prepare(sql).iterate(...p),
  };
  const stats = runAggregation(adapter, { period: "all", range: {}, connectionMap: {}, apiKeyMap: {}, providerNodeNameMap: {}, sourceCapture: {}, now: new Date("2026-09-21T00:00:00Z"), ...maps });
  db.close();
  return stats;
}

function rollupStats(rollupDb, maps = {}) {
  const adapter = { all: (sql, p = []) => rollupDb.prepare(sql).all(...p) };
  return runRollupAggregation(adapter, { period: "all", range: {}, connectionMap: {}, apiKeyMap: {}, providerNodeNameMap: {}, now: new Date("2026-09-21T00:00:00Z"), ...maps });
}

const DIMENSIONS = ["byProvider", "byModel", "byAccount", "byApiKey", "byEndpoint", "bySourceIp", "byApp"];

function totalsOf(map) {
  const buckets = Object.values(map || {});
  return {
    requests: buckets.reduce((s, b) => s + (b.requests || 0), 0),
    promptTokens: buckets.reduce((s, b) => s + (b.promptTokens || 0), 0),
    completionTokens: buckets.reduce((s, b) => s + (b.completionTokens || 0), 0),
    cachedTokens: buckets.reduce((s, b) => s + (b.cachedTokens || 0), 0),
    cost: buckets.reduce((s, b) => s + (b.cost || 0), 0),
  };
}

describe("rollup read path", () => {
  it("matches the raw aggregation on every dimension's totals", async () => {
    const events = [
      makeEvent({ requestId: "a" }),
      makeEvent({ requestId: "b", model: "gpt-5.6-terra", cost: 0.02, promptTokens: 2000, completionTokens: 80,
        tokens: JSON.stringify({ prompt_tokens: 2000, completion_tokens: 80, cached_tokens: 0 }) }),
      makeEvent({ requestId: "c", provider: "deepseek", model: "deepseek-v4-flash", connectionId: "conn-2",
        apiKeyId: "key-2", cost: 0.005, meta: JSON.stringify({ sourceIp: "5.6.7.8", userAgent: "curl/8.0" }) }),
      makeEvent({ requestId: "d", status: "error" }),
      makeEvent({ requestId: "e", status: "cancelled" }),
      makeEvent({ requestId: "f", status: "blocked:account_locked" }),
    ];

    const db = await buildRollup(events);
    const rolled = rollupStats(db);
    const raw = rawStats(events);
    db.close();

    for (const dim of DIMENSIONS) {
      const r = totalsOf(rolled[dim]);
      const w = totalsOf(raw[dim]);
      expect(r.requests, `${dim} requests`).toBe(w.requests);
      expect(r.promptTokens, `${dim} promptTokens`).toBe(w.promptTokens);
      expect(r.completionTokens, `${dim} completionTokens`).toBe(w.completionTokens);
      expect(r.cachedTokens, `${dim} cachedTokens`).toBe(w.cachedTokens);
      expect(r.cost, `${dim} cost`).toBeCloseTo(w.cost, 9);
    }
  });

  it("produces the same bucket keys the raw path does", async () => {
    const events = [makeEvent({ requestId: "a" }), makeEvent({ requestId: "b", model: "gpt-5.6-terra" })];
    const db = await buildRollup(events);
    const rolled = rollupStats(db);
    const raw = rawStats(events);
    db.close();

    for (const dim of DIMENSIONS) {
      expect(Object.keys(rolled[dim]).sort(), `${dim} keys`).toEqual(Object.keys(raw[dim]).sort());
    }
  });

  it("matches the status counts, including the exact-match rule", async () => {
    // The raw path counts ONLY status === "cancelled" / "error"; prefixed
    // statuses fall into completed. A naive prefix match would diverge here.
    const events = [
      makeEvent({ requestId: "ok1", status: "success" }),
      makeEvent({ requestId: "ok2", status: "blocked:account_locked" }),
      makeEvent({ requestId: "ok3", status: "upstream:503" }),
      makeEvent({ requestId: "bad", status: "error" }),
      makeEvent({ requestId: "cxl", status: "cancelled" }),
    ];
    const db = await buildRollup(events);
    const rolled = rollupStats(db);
    const raw = rawStats(events);
    db.close();

    expect(rolled.completedRequests).toBe(raw.completedRequests);
    expect(rolled.failedRequests).toBe(raw.failedRequests);
    expect(rolled.cancelledRequests).toBe(raw.cancelledRequests);
    expect(rolled.completedRequests).toBe(3);
    expect(rolled.failedRequests).toBe(1);
    expect(rolled.cancelledRequests).toBe(1);
  });

  it("counts totalRequests once per event, not once per bucket", async () => {
    const events = [makeEvent({ requestId: "a" }), makeEvent({ requestId: "b" })];
    const db = await buildRollup(events);
    const rolled = rollupStats(db);
    const raw = rawStats(events);
    db.close();

    expect(rolled.totalRequests).toBe(raw.totalRequests);
    expect(rolled.totalRequests).toBe(2);
  });

  it("produces the token and cost totals the overview cards read", async () => {
    // These are the same single-dimension sums as totalRequests — computing
    // them per-row would inflate them by the buckets-per-event count.
    const events = [
      makeEvent({ requestId: "a" }),
      makeEvent({ requestId: "b", promptTokens: 2000, completionTokens: 80, cost: 0.02,
        tokens: JSON.stringify({ prompt_tokens: 2000, completion_tokens: 80, cached_tokens: 0 }) }),
    ];
    const db = await buildRollup(events);
    const rolled = rollupStats(db);
    const raw = rawStats(events);
    db.close();

    expect(rolled.totalPromptTokens).toBe(raw.totalPromptTokens);
    expect(rolled.totalCompletionTokens).toBe(raw.totalCompletionTokens);
    expect(rolled.totalCachedTokens).toBe(raw.totalCachedTokens);
    expect(rolled.totalCost).toBeCloseTo(raw.totalCost, 9);
  });

  it("aggregates across multiple days", async () => {
    const events = [
      makeEvent({ requestId: "d1", completedAt: "2026-09-19T10:00:00.000Z", timestamp: "2026-09-19T10:00:00.000Z" }),
      makeEvent({ requestId: "d2", completedAt: "2026-09-20T10:00:00.000Z", timestamp: "2026-09-20T10:00:00.000Z" }),
    ];
    const db = await buildRollup(events);
    const adapter = { all: (sql, p = []) => db.prepare(sql).all(...p) };
    const rolled = runRollupAggregation(adapter, { period: "all", range: {}, connectionMap: {}, apiKeyMap: {}, providerNodeNameMap: {}, now: new Date("2026-09-21T00:00:00Z") });
    db.close();

    expect(rolled.totalRequests).toBe(2);
    expect(rolled.byProvider.codex.requests).toBe(2);
  });

  it("filters by dateKey range", async () => {
    const events = [
      makeEvent({ requestId: "old", completedAt: "2026-09-01T10:00:00.000Z", timestamp: "2026-09-01T10:00:00.000Z" }),
      makeEvent({ requestId: "new", completedAt: "2026-09-20T10:00:00.000Z", timestamp: "2026-09-20T10:00:00.000Z" }),
    ];
    const db = await buildRollup(events);
    const adapter = { all: (sql, p = []) => db.prepare(sql).all(...p) };
    const rolled = runRollupAggregation(adapter, {
      period: "custom", range: { startDate: "2026-09-15T00:00:00.000Z", endDate: "2026-09-21T00:00:00.000Z" },
      connectionMap: {}, apiKeyMap: {}, providerNodeNameMap: {}, now: new Date("2026-09-21T00:00:00Z"),
    });
    db.close();

    expect(rolled.totalRequests).toBe(1);
  });

  it("resolves period windows to local date keys", () => {
    const now = new Date("2026-09-20T12:00:00.000Z");
    expect(resolveDateKeyRange("today", {}, now)).toEqual({ from: localDateKey(now), to: localDateKey(now) });

    const week = resolveDateKeyRange("7d", {}, now);
    expect(week.to).toBe(localDateKey(now));
    expect(week.from).toBe(localDateKey(new Date(now.getTime() - 7 * 86400_000)));

    // A rolling-hour window has no exact day-granular equivalent.
    expect(resolveDateKeyRange("24h", {}, now)).toEqual({ from: null, to: null });
  });

  it("never claims a byUser it cannot support", async () => {
    const db = await buildRollup([makeEvent({ requestId: "a" })]);
    const rolled = rollupStats(db);
    db.close();
    // The caller merges the raw path's byUser; this module must not pretend.
    expect(rolled.byUser).toEqual({});
    expect(rolled.source).toBe("rollup");
  });
});
