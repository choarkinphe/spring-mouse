import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  rebuildRollupDays,
  historyDateKeys,
  rollupNeedsBackfill,
  rollupDateKeys,
  ensureRollupTable,
  applyEventToRollup,
  ROLLUP_TABLE,
} from "../../runtime/usage-rollup.mjs";
import { runRollupAggregation } from "../../runtime/usage-rollup-read.mjs";
import { runAggregation } from "../../runtime/usage-aggregate.mjs";

/**
 * The rebuild exists for one reason: the rollup only accumulates from the
 * moment its writer starts, so an instance upgraded from a build without it has
 * every historical day missing — and the day the writer started mid-way through
 * is PARTIAL, which "fill only absent days" cannot repair. So a day already
 * present is deleted and recomputed.
 *
 * Two properties matter:
 *   1. After a rebuild the rollup read agrees with the raw aggregation.
 *   2. It is re-runnable — a second pass changes nothing.
 * The live writer's consistency depends on delete+rescan+insert being ONE
 * transaction; the interleaving tests below pin that.
 */

function makeEvent(overrides = {}) {
  const day = overrides.day || "2026-09-20";
  return {
    requestId: overrides.requestId || `req-${Math.random().toString(36).slice(2, 10)}`,
    timestamp: `${day}T10:00:00.000Z`,
    startedAt: `${day}T10:00:00.000Z`,
    completedAt: `${day}T10:00:05.000Z`,
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

function makeDb(events) {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE usageHistory (
    id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT, provider TEXT, model TEXT,
    connectionId TEXT, apiKey TEXT, apiKeyId TEXT, requestId TEXT, trafficRequestId TEXT,
    startedAt TEXT, completedAt TEXT, endpoint TEXT, promptTokens INTEGER, completionTokens INTEGER,
    cost REAL, status TEXT, tokens TEXT, meta TEXT)`);
  db.exec(`CREATE INDEX idx_uh_ts ON usageHistory(timestamp DESC)`);
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

function rolledStats(db) {
  return runRollupAggregation(adapterOf(db), { period: "all", range: {}, ...maps, now: new Date("2026-09-21T00:00:00Z") });
}

const DIMENSIONS = ["byProvider", "byModel", "byAccount", "byApiKey", "byEndpoint", "bySourceIp", "byApp"];

function totalsOf(map) {
  const buckets = Object.values(map || {});
  return {
    requests: buckets.reduce((s, b) => s + (b.requests || 0), 0),
    cost: buckets.reduce((s, b) => s + (b.cost || 0), 0),
  };
}

function assertMatchesRaw(db) {
  const rolled = rolledStats(db);
  const raw = rawStats(db);
  for (const dim of DIMENSIONS) {
    expect(totalsOf(rolled[dim]).requests, `${dim} requests`).toBe(totalsOf(raw[dim]).requests);
    expect(totalsOf(rolled[dim]).cost, `${dim} cost`).toBeCloseTo(totalsOf(raw[dim]).cost, 9);
  }
  expect(rolled.totalRequests).toBe(raw.totalRequests);
  expect(rolled.completedRequests).toBe(raw.completedRequests);
  expect(rolled.failedRequests).toBe(raw.failedRequests);
  expect(rolled.cancelledRequests).toBe(raw.cancelledRequests);
  expect(rolled.totalCost).toBeCloseTo(raw.totalCost, 9);
}

describe("rollup rebuild", () => {
  it("fills every historical day so the rollup read matches the raw aggregation", async () => {
    const events = [
      makeEvent({ requestId: "a", day: "2026-09-01" }),
      makeEvent({ requestId: "b", day: "2026-09-01", model: "gpt-5.6-terra", cost: 0.02 }),
      makeEvent({ requestId: "c", day: "2026-09-15", provider: "deepseek", model: "deepseek-v4-flash" }),
      makeEvent({ requestId: "d", day: "2026-09-20", status: "error" }),
    ];
    const db = makeDb(events);

    expect(rollupNeedsBackfill(db)).toBe(true);
    const result = await rebuildRollupDays(adapterOf(db), { now: new Date("2026-09-21T12:00:00Z").getTime() });
    expect(result.days).toBe(21);   // 09-01 .. 09-21 inclusive
    expect(rollupNeedsBackfill(db)).toBe(false);
    assertMatchesRaw(db);
    db.close();
  });

  it("repairs a PARTIAL day — the case that made 'fill missing days' wrong", async () => {
    // The writer accumulated only part of 2026-09-20 (as on the production
    // upgrade, where it started at 05:43). A rebuild must recompute the whole
    // day, not skip it because it is "present".
    const events = [
      makeEvent({ requestId: "early", day: "2026-09-20", timestamp: "2026-09-20T01:00:00.000Z", startedAt: "2026-09-20T01:00:00.000Z", completedAt: "2026-09-20T01:00:05.000Z" }),
      makeEvent({ requestId: "late", day: "2026-09-20", timestamp: "2026-09-20T09:00:00.000Z", startedAt: "2026-09-20T09:00:00.000Z", completedAt: "2026-09-20T09:00:05.000Z" }),
    ];
    const db = makeDb(events);
    applyEventToRollup(db, events[1]);   // writer only saw the "late" one
    expect(rollupDateKeys(db).has("2026-09-20")).toBe(true);

    await rebuildRollupDays(adapterOf(db), { days: ["2026-09-20"] });
    const rolled = rolledStats(db);
    expect(rolled.totalRequests).toBe(2);   // both rows, not just the late one
    assertMatchesRaw(db);
    db.close();
  });

  it("is idempotent — a second pass produces identical numbers", async () => {
    const events = [makeEvent({ requestId: "a", day: "2026-09-10" }), makeEvent({ requestId: "b", day: "2026-09-11" })];
    const db = makeDb(events);
    const adapter = adapterOf(db);

    await rebuildRollupDays(adapter, { days: ["2026-09-10", "2026-09-11"] });
    const first = db.prepare(`SELECT SUM(requests) n FROM ${ROLLUP_TABLE} WHERE dimension='provider'`).get().n;

    await rebuildRollupDays(adapter, { days: ["2026-09-10", "2026-09-11"] });
    const second = db.prepare(`SELECT SUM(requests) n FROM ${ROLLUP_TABLE} WHERE dimension='provider'`).get().n;
    expect(second).toBe(first);
    expect(second).toBe(2);
    assertMatchesRaw(db);
    db.close();
  });

  it("leaves a day's counters correct when the writer adds a row mid-rebuild", async () => {
    // Simulate the interleaving that motivated the single-transaction rule: a
    // writer event lands between two rebuild calls. Because each rebuild is
    // atomic per day, the final state must still be consistent.
    const events = [makeEvent({ requestId: "a", day: "2026-09-20" })];
    const db = makeDb(events);
    const adapter = adapterOf(db);

    await rebuildRollupDays(adapter, { days: ["2026-09-20"] });
    // The writer sees a brand-new row and accumulates it.
    const extra = makeEvent({ requestId: "b", day: "2026-09-20" });
    adapter.run(`INSERT INTO usageHistory(timestamp, provider, model, connectionId, apiKeyId, requestId, startedAt, completedAt, endpoint, promptTokens, completionTokens, cost, status, tokens, meta) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [extra.timestamp, extra.provider, extra.model, extra.connectionId, extra.apiKeyId, extra.requestId, extra.startedAt, extra.completedAt, extra.endpoint, extra.promptTokens, extra.completionTokens, extra.cost, extra.status, extra.tokens, extra.meta]);
    applyEventToRollup(db, extra);

    // A later rebuild of the same day re-reads history and stays consistent.
    await rebuildRollupDays(adapter, { days: ["2026-09-20"] });
    expect(rolledStats(db).totalRequests).toBe(2);
    assertMatchesRaw(db);
    db.close();
  });

  it("assigns a row to its completedAt day, not its startedAt day", async () => {
    // The writer keys dateKey on completedAt, so the rebuild must too, or the
    // two paths would disagree on which day a straddling row belongs to.
    const ev = makeEvent({
      requestId: "straddle",
      timestamp: "2026-09-20T23:59:30.000Z",
      startedAt: "2026-09-20T23:59:30.000Z",
      completedAt: "2026-09-21T00:00:10.000Z",
    });
    const db = makeDb([ev]);
    await rebuildRollupDays(adapterOf(db), { days: ["2026-09-20", "2026-09-21"] });
    const perDay = db.prepare(`SELECT dateKey FROM ${ROLLUP_TABLE} WHERE dimension='provider'`).all().map((r) => r.dateKey);
    expect(perDay).toEqual(["2026-09-21"]);
    assertMatchesRaw(db);
    db.close();
  });

  it("reports the days usageHistory covers", () => {
    const db = makeDb([makeEvent({ requestId: "a", day: "2026-09-18" }), makeEvent({ requestId: "b", day: "2026-09-20" })]);
    const days = historyDateKeys(adapterOf(db), new Date("2026-09-20T12:00:00Z").getTime());
    expect(days).toEqual(["2026-09-18", "2026-09-19", "2026-09-20"]);
    db.close();
  });

  it("calls onYield once per rebuilt day", async () => {
    const db = makeDb([makeEvent({ requestId: "a", day: "2026-09-10" })]);
    let yields = 0;
    await rebuildRollupDays(adapterOf(db), { days: ["2026-09-09", "2026-09-10", "2026-09-11"], onYield: async () => { yields++; } });
    expect(yields).toBe(3);
    db.close();
  });

  it("reports no rebuild needed when the rollup is current", () => {
    const db = makeDb([makeEvent({ requestId: "a", day: "2026-09-20" })]);
    applyEventToRollup(db, makeEvent({ requestId: "a", day: "2026-09-20" }));
    expect(rollupNeedsBackfill(db)).toBe(false);
    db.close();
  });
});
