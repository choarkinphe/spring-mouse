import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  rollupRowDelta,
  mergeRollupRow,
  applyEventToRollup,
  ensureRollupTable,
  rebuildRollupDays,
  historyDateKeys,
  rollupNeedsBackfill,
  addSessionInterval,
  sessionsFromIntervals,
  setCompleteThrough,
  getCompleteThrough,
  ROLLUP_TABLE,
} from "../../runtime/usage-rollup.mjs";
import { runRollupAggregation, readUserRollup } from "../../runtime/usage-rollup-read.mjs";
import { runAggregation } from "../../runtime/usage-aggregate.mjs";

/**
 * ONE table, keyed (day, API key). Every dimension the dashboard shows is either
 * a sum over (day, key) or a sum over one of the row's (key, X) maps.
 *
 * The property that matters: this table must reproduce the raw aggregation
 * EXACTLY — all six aggregate dimensions, `byUser` with its session metrics, the
 * status counts and the totals. If it drifts, the board shows different numbers
 * before and after the rollup boundary and nobody can tell which is right.
 */

const DIMENSIONS = ["byProvider", "byModel", "byAccount", "byApiKey", "byEndpoint", "bySourceIp", "byApp"];

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

function rawStats(db, override = {}) {
  return runAggregation(adapterOf(db), { period: "all", range: {}, ...maps, ...override, now: new Date("2026-09-21T00:00:00Z") });
}
function rolledStats(db, override = {}) {
  return runRollupAggregation(adapterOf(db), { period: "all", range: {}, ...maps, ...override, now: new Date("2026-09-21T00:00:00Z") });
}
function rolledByUser(db, override = {}) {
  return readUserRollup(adapterOf(db), { ...maps, ...override });
}

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

function assertMatchesRaw(db, override = {}) {
  const rolled = rolledStats(db, override);
  const raw = rawStats(db, override);
  for (const dim of DIMENSIONS) {
    const r = totalsOf(rolled[dim]);
    const w = totalsOf(raw[dim]);
    expect(r.requests, `${dim} requests`).toBe(w.requests);
    expect(r.promptTokens, `${dim} promptTokens`).toBe(w.promptTokens);
    expect(r.completionTokens, `${dim} completionTokens`).toBe(w.completionTokens);
    expect(r.cachedTokens, `${dim} cachedTokens`).toBe(w.cachedTokens);
    expect(r.cost, `${dim} cost`).toBeCloseTo(w.cost, 9);
  }
  expect(rolled.totalRequests).toBe(raw.totalRequests);
  expect(rolled.totalPromptTokens).toBe(raw.totalPromptTokens);
  expect(rolled.totalCompletionTokens).toBe(raw.totalCompletionTokens);
  expect(rolled.totalCachedTokens).toBe(raw.totalCachedTokens);
  expect(rolled.totalCost).toBeCloseTo(raw.totalCost, 9);
  expect(rolled.completedRequests).toBe(raw.completedRequests);
  expect(rolled.failedRequests).toBe(raw.failedRequests);
  expect(rolled.cancelledRequests).toBe(raw.cancelledRequests);
}

describe("usage rollup — session intervals", () => {
  const t = (min) => min * 60_000;

  it("coalesces touching intervals and keeps separate ones apart", () => {
    let intervals = [];
    intervals = addSessionInterval(intervals, t(0), t(5));
    intervals = addSessionInterval(intervals, t(10), t(15));
    intervals = addSessionInterval(intervals, t(120), t(125));
    expect(intervals).toEqual([[t(0), t(15)], [t(120), t(125)]]);
    expect(sessionsFromIntervals(intervals)).toEqual({ count: 2, durationMs: t(15) + t(5) });
  });

  it("bridges two sessions when an event lands between them", () => {
    const intervals = addSessionInterval([[t(0), t(5)], [t(120), t(125)]], t(20), t(100));
    expect(intervals).toEqual([[t(0), t(125)]]);
  });

  it("is order-independent — any arrival order gives the same result", () => {
    const events = [[t(0), t(5)], [t(200), t(205)], [t(20), t(25)], [t(400), t(410)]];
    const forward = events.reduce((acc, [s, e]) => addSessionInterval(acc, s, e), []);
    const backward = [...events].reverse().reduce((acc, [s, e]) => addSessionInterval(acc, s, e), []);
    expect(forward).toEqual(backward);
  });
});

describe("usage rollup — agreement with the raw aggregation", () => {
  it("matches every dimension, the totals and the status counts", () => {
    const events = [
      makeEvent({ requestId: "a" }),
      makeEvent({ requestId: "b", model: "gpt-5.6-terra", cost: 0.02, promptTokens: 2000, completionTokens: 80, tokens: JSON.stringify({ prompt_tokens: 2000, completion_tokens: 80, cached_tokens: 0 }) }),
      makeEvent({ requestId: "c", provider: "deepseek", model: "deepseek-v4-flash", connectionId: "conn-2", apiKeyId: "key-2", cost: 0.005, meta: JSON.stringify({ sourceIp: "5.6.7.8", userAgent: "curl/8.0" }) }),
      makeEvent({ requestId: "d", status: "error" }),
      makeEvent({ requestId: "e", status: "cancelled" }),
      makeEvent({ requestId: "f", status: "blocked:account_locked" }),
      makeEvent({ requestId: "g", provider: null, model: null, connectionId: null }),
      makeEvent({ requestId: "h", day: "2026-09-19" }),
    ];
    const db = makeDb(events);
    for (const e of events) applyEventToRollup(db, e);

    assertMatchesRaw(db);
    // The exact-match status rule: only `cancelled`/`error` are special, so
    // `blocked:account_locked` counts as completed.
    const rolled = rolledStats(db);
    expect(rolled.completedRequests).toBe(6);
    expect(rolled.failedRequests).toBe(1);
    expect(rolled.cancelledRequests).toBe(1);
    db.close();
  });

  it("reproduces byUser, including session metrics and the (user, X) maps", () => {
    const events = [
      makeEvent({ requestId: "a" }),
      makeEvent({ requestId: "b", model: "gpt-5.6-terra", cost: 0.02 }),
      makeEvent({ requestId: "c", apiKeyId: "key-2", meta: JSON.stringify({ sourceIp: "5.6.7.8", userAgent: "curl/8.0" }) }),
      makeEvent({ requestId: "d", status: "error" }),
      makeEvent({ requestId: "e", day: "2026-09-19" }),
    ];
    const db = makeDb(events);
    for (const e of events) applyEventToRollup(db, e);

    const rolled = rolledByUser(db);
    const raw = rawStats(db).byUser;
    expect(Object.keys(rolled).sort()).toEqual(Object.keys(raw).sort());
    for (const key of Object.keys(raw)) {
      const r = rolled[key];
      const w = raw[key];
      for (const field of ["requests", "completedRequests", "failedRequests", "cancelledRequests",
        "promptTokens", "completionTokens", "cachedTokens", "requestDurationMs", "durationRequestCount",
        "sessionCount", "activeSessionDurationMs", "activeDays", "firstUsed", "lastUsed", "keyName", "apiKeyMasked"]) {
        expect(r[field], `${key}.${field}`).toBe(w[field]);
      }
      expect(r.cost, `${key}.cost`).toBeCloseTo(w.cost, 9);
      expect(r.periods).toEqual(w.periods);
      expect(r.weekdays).toEqual(w.weekdays);
      for (const m of ["models", "apps", "sourceIps"]) {
        expect(Object.keys(r[m]).sort(), `${key}.${m}`).toEqual(Object.keys(w[m]).sort());
      }
    }
    db.close();
  });

  it("merges a session spanning local midnight instead of counting it twice", () => {
    const beforeStart = new Date(2026, 8, 20, 23, 50, 0);
    const afterStart = new Date(2026, 8, 21, 0, 20, 0);
    const evA = makeEvent({ requestId: "a", timestamp: beforeStart.toISOString(), startedAt: beforeStart.toISOString(), completedAt: new Date(2026, 8, 20, 23, 55, 0).toISOString() });
    const evB = makeEvent({ requestId: "b", timestamp: afterStart.toISOString(), startedAt: afterStart.toISOString(), completedAt: new Date(2026, 8, 21, 0, 25, 0).toISOString() });

    expect(rollupRowDelta(evA).dateKey).toBe("2026-09-20");
    expect(rollupRowDelta(evB).dateKey).toBe("2026-09-21");

    const db = makeDb([evA, evB]);
    applyEventToRollup(db, evA);
    applyEventToRollup(db, evB);
    const rolled = rolledByUser(db);
    const raw = rawStats(db).byUser;
    expect(rolled["key-1"].sessionCount).toBe(1);
    expect(raw["key-1"].sessionCount).toBe(1);
    expect(rolled["key-1"].activeSessionDurationMs).toBe(raw["key-1"].activeSessionDurationMs);
    db.close();
  });

  it("resolves the display provider name the same way the raw path does", () => {
    const events = [makeEvent({ requestId: "a", provider: "codex", model: "gpt-5.6-sol" })];
    const db = makeDb(events);
    applyEventToRollup(db, events[0]);

    const override = { providerNodeNameMap: { codex: "Codex Pro" } };
    const rolled = rolledStats(db, override);
    const raw = rawStats(db, override);
    // byModel keys on the RAW provider id, and its `provider` field carries the
    // display name — same as the raw path.
    expect(Object.keys(rolled.byModel)).toEqual(["gpt-5.6-sol (codex)"]);
    expect(rolled.byModel["gpt-5.6-sol (codex)"].provider).toBe("Codex Pro");
    expect(rolled.byModel["gpt-5.6-sol (codex)"].provider).toBe(raw.byModel["gpt-5.6-sol (codex)"].provider);
    expect(Object.keys(rolled.byProvider)).toEqual(["codex"]);
    // byUser.models uses the DISPLAY name, as the raw path's person branch does.
    expect(Object.keys(rolledByUser(db, override)["key-1"].models)).toEqual(["gpt-5.6-sol (Codex Pro)"]);
    expect(Object.keys(raw.byUser["key-1"].models)).toEqual(["gpt-5.6-sol (Codex Pro)"]);
    db.close();
  });
});

describe("usage rollup — scoping", () => {
  it("scopes EVERY dimension by apiKeyId, not just the apiKey one", () => {
    // The reason the key is in the primary key: a dimension-per-row table cannot
    // filter provider/model/app by key, so a scoped view would report unscoped
    // numbers. Here the filter is on the row, so all dimensions narrow together.
    const events = [
      makeEvent({ requestId: "a", apiKeyId: "key-1", provider: "codex" }),
      makeEvent({ requestId: "b", apiKeyId: "key-2", provider: "deepseek", model: "deepseek-v4-flash" }),
    ];
    const db = makeDb(events);
    for (const e of events) applyEventToRollup(db, e);

    const scoped = rolledStats(db, { range: { apiKeyIds: ["key-1"] } });
    expect(scoped.totalRequests).toBe(1);
    expect(Object.keys(scoped.byProvider)).toEqual(["codex"]);
    expect(Object.keys(scoped.byModel)).toEqual(["gpt-5.6-sol (codex)"]);
    expect(totalsOf(scoped.byApp).requests).toBe(1);

    // An empty scope matches nothing (not everything).
    expect(rolledStats(db, { range: { apiKeyIds: [] } }).totalRequests).toBe(0);
    db.close();
  });

  it("scopes byUser by the same key set", () => {
    const events = [makeEvent({ requestId: "a", apiKeyId: "key-1" }), makeEvent({ requestId: "b", apiKeyId: "key-2" })];
    const db = makeDb(events);
    for (const e of events) applyEventToRollup(db, e);
    const scoped = readUserRollup(adapterOf(db), { apiKeyIds: ["key-2"] });
    expect(Object.keys(scoped)).toEqual(["key-2"]);
    db.close();
  });
});

describe("usage rollup — rebuild", () => {
  it("fills history so the rollup matches raw, and is idempotent", async () => {
    const events = [
      makeEvent({ requestId: "a", day: "2026-09-01" }),
      makeEvent({ requestId: "b", day: "2026-09-15", provider: "deepseek", model: "deepseek-v4-flash" }),
      makeEvent({ requestId: "c", day: "2026-09-20", status: "error" }),
    ];
    const db = makeDb(events);
    const adapter = adapterOf(db);

    expect(rollupNeedsBackfill(adapter, new Date("2026-09-21T12:00:00Z").getTime())).toBe(true);
    const result = await rebuildRollupDays(adapter, { now: new Date("2026-09-21T12:00:00Z").getTime() });
    expect(result.days).toBe(21);
    expect(result.completeThrough).toBe("2026-09-21");
    expect(rollupNeedsBackfill(adapter, new Date("2026-09-21T12:00:00Z").getTime())).toBe(false);
    assertMatchesRaw(db);

    const before = db.prepare(`SELECT SUM(requests) n FROM ${ROLLUP_TABLE}`).get().n;
    await rebuildRollupDays(adapter, { days: ["2026-09-01", "2026-09-15", "2026-09-20"] });
    expect(db.prepare(`SELECT SUM(requests) n FROM ${ROLLUP_TABLE}`).get().n).toBe(before);
    assertMatchesRaw(db);
    db.close();
  });

  it("repairs a PARTIAL day — the case 'fill missing days' cannot fix", async () => {
    // The writer accumulated only part of 2026-09-20 (as on the production
    // upgrade, where it started at 05:43). A rebuild recomputes the whole day.
    const events = [
      makeEvent({ requestId: "early", day: "2026-09-20", timestamp: "2026-09-20T01:00:00.000Z", startedAt: "2026-09-20T01:00:00.000Z", completedAt: "2026-09-20T01:00:05.000Z" }),
      makeEvent({ requestId: "late", day: "2026-09-20", timestamp: "2026-09-20T09:00:00.000Z", startedAt: "2026-09-20T09:00:00.000Z", completedAt: "2026-09-20T09:00:05.000Z" }),
    ];
    const db = makeDb(events);
    applyEventToRollup(db, events[1]);   // the writer only saw the late one
    expect(rolledStats(db).totalRequests).toBe(1);

    await rebuildRollupDays(adapterOf(db), { days: ["2026-09-20"] });
    expect(rolledStats(db).totalRequests).toBe(2);
    assertMatchesRaw(db);
    db.close();
  });

  it("assigns a row to its START day, matching the raw path's basis", async () => {
    // Local-time constructors, because the rollup keys on the LOCAL day (as the
    // raw path does via getLocalDateKey(startedAt)); a UTC literal would land on
    // a different local day depending on the machine's timezone.
    const start = new Date(2026, 8, 20, 23, 59, 30);
    const end = new Date(2026, 8, 21, 0, 0, 10);
    const ev = makeEvent({
      requestId: "straddle",
      timestamp: start.toISOString(),
      startedAt: start.toISOString(),
      completedAt: end.toISOString(),
    });
    const db = makeDb([ev]);
    await rebuildRollupDays(adapterOf(db), { days: ["2026-09-20", "2026-09-21"] });
    const days = db.prepare(`SELECT dateKey FROM ${ROLLUP_TABLE}`).all().map((r) => r.dateKey);
    expect(days).toEqual(["2026-09-20"]);
    assertMatchesRaw(db);
    db.close();
  });

  it("reports the days usageHistory covers", () => {
    const db = makeDb([makeEvent({ requestId: "a", day: "2026-09-18" }), makeEvent({ requestId: "b", day: "2026-09-20" })]);
    expect(historyDateKeys(adapterOf(db), new Date("2026-09-20T12:00:00Z").getTime())).toEqual(["2026-09-18", "2026-09-19", "2026-09-20"]);
    db.close();
  });

  it("tracks completeness so an unrebuilt day is not trusted", () => {
    const db = makeDb([makeEvent({ requestId: "a", day: "2026-09-20" })]);
    const adapter = adapterOf(db);
    expect(getCompleteThrough(adapter)).toBe(null);
    expect(rollupNeedsBackfill(adapter, new Date("2026-09-20T12:00:00Z").getTime())).toBe(true);

    setCompleteThrough(adapter, "2026-09-20");
    expect(getCompleteThrough(adapter)).toBe("2026-09-20");
    expect(rollupNeedsBackfill(adapter, new Date("2026-09-20T12:00:00Z").getTime())).toBe(false);

    // The marker never moves backwards.
    setCompleteThrough(adapter, "2026-09-01");
    expect(getCompleteThrough(adapter)).toBe("2026-09-20");
    db.close();
  });

  it("calls onYield once per rebuilt day", async () => {
    const db = makeDb([makeEvent({ requestId: "a", day: "2026-09-10" })]);
    let yields = 0;
    await rebuildRollupDays(adapterOf(db), { days: ["2026-09-09", "2026-09-10", "2026-09-11"], onYield: async () => { yields++; } });
    expect(yields).toBe(3);
    db.close();
  });
});

describe("usage rollup — pure merge", () => {
  it("folds deltas without a database", () => {
    const a = rollupRowDelta(makeEvent({ requestId: "a" }));
    const b = rollupRowDelta(makeEvent({ requestId: "b", promptTokens: 500, completionTokens: 25, cost: 0.005 }));
    const merged = mergeRollupRow(mergeRollupRow(null, a), b);
    expect(merged.requests).toBe(2);
    expect(merged.promptTokens).toBe(1500);
    expect(merged.completionTokens).toBe(75);
    expect(merged.cost).toBeCloseTo(0.015, 9);
    expect(Object.keys(merged.models)).toEqual(["gpt-5.6-sol|codex"]);
    expect(merged.models["gpt-5.6-sol|codex"].requests).toBe(2);
    expect(merged.accounts["conn-1|gpt-5.6-sol|codex"].requests).toBe(2);
    expect(merged.endpoints["/v1/chat/completions|gpt-5.6-sol|codex"].requests).toBe(2);
  });

  it("stores a null model/provider as empty parts", () => {
    const delta = rollupRowDelta(makeEvent({ provider: null, model: null, connectionId: null }));
    expect(Object.keys(delta.models)).toEqual(["|"]);
    expect(delta.accounts).toEqual({});                       // connectionId null → no account bucket
    expect(Object.keys(delta.endpoints)).toEqual(["/v1/chat/completions||"]);
  });
});
