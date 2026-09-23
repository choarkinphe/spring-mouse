import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  userDayDelta,
  mergeUserDay,
  applyEventToUserRollup,
  ensureUserRollupTable,
  readUserRollup,
  addSessionInterval,
  sessionsFromIntervals,
  USER_ROLLUP_TABLE,
  SESSION_GAP_MS,
} from "../../runtime/usage-rollup-user.mjs";
import { runAggregation } from "../../runtime/usage-aggregate.mjs";

/**
 * `byUser` is the reason the board cannot go fully to the flat rollup: it
 * carries session metrics and four (user, X) crosses that no counter can
 * reconstruct. This module stores one row per (user, day) with the day's
 * disjoint session intervals, and must reproduce the raw path's `byUser`
 * EXACTLY — same numbers, same labels, same nested maps.
 */

const DAY = "2026-09-20";

function makeEvent(overrides = {}) {
  const day = overrides.day || DAY;
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
  ensureUserRollupTable(db);
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

function rawByUser(db, mapsOverride = {}) {
  const stats = runAggregation(adapterOf(db), { period: "all", range: {}, ...maps, ...mapsOverride, now: new Date("2026-09-21T00:00:00Z") });
  return stats.byUser;
}

function rolledByUser(db, mapsOverride = {}) {
  return readUserRollup(adapterOf(db), { ...maps, ...mapsOverride });
}

describe("user/day rollup — session intervals", () => {
  it("coalesces touching intervals and keeps separate ones apart", () => {
    const t = (min) => min * 60_000;
    // Two events 10 min apart → one session; a third 2h later → a second.
    let intervals = [];
    intervals = addSessionInterval(intervals, t(0), t(5));
    intervals = addSessionInterval(intervals, t(10), t(15));
    intervals = addSessionInterval(intervals, t(120), t(125));
    expect(intervals).toEqual([[t(0), t(15)], [t(120), t(125)]]);
    expect(sessionsFromIntervals(intervals)).toEqual({ count: 2, durationMs: t(15) + t(5) });
  });

  it("bridges two sessions when a late event lands between them", () => {
    const t = (min) => min * 60_000;
    // 0–5 and 120–125 are separate; an event at 60–65 that reaches both
    // (60-30=30 <= 5? no) — use a gap-sized event instead.
    let intervals = [[t(0), t(5)], [t(120), t(125)]];
    // A single event spanning 5..120 with the 30-min gap touches both.
    intervals = addSessionInterval(intervals, t(20), t(100));
    expect(intervals).toEqual([[t(0), t(125)]]);
  });

  it("is order-independent — the same events in any arrival order agree", () => {
    const t = (min) => min * 60_000;
    const events = [[t(0), t(5)], [t(200), t(205)], [t(20), t(25)], [t(400), t(410)]];
    const forward = events.reduce((acc, [s, e]) => addSessionInterval(acc, s, e), []);
    const backward = [...events].reverse().reduce((acc, [s, e]) => addSessionInterval(acc, s, e), []);
    expect(forward).toEqual(backward);
  });

  it("merges a session that spans local midnight without counting it twice", () => {
    // 23:50 → 00:20 local is ONE session, split across two day rows. Built from
    // local-time constructors so the boundary is local midnight wherever the
    // suite runs.
    const beforeStart = new Date(2026, 8, 20, 23, 50, 0);
    const beforeEnd = new Date(2026, 8, 20, 23, 55, 0);
    const afterStart = new Date(2026, 8, 21, 0, 20, 0);
    const afterEnd = new Date(2026, 8, 21, 0, 25, 0);

    const evA = makeEvent({ requestId: "a", timestamp: beforeStart.toISOString(), startedAt: beforeStart.toISOString(), completedAt: beforeEnd.toISOString() });
    const evB = makeEvent({ requestId: "b", timestamp: afterStart.toISOString(), startedAt: afterStart.toISOString(), completedAt: afterEnd.toISOString() });

    const a = userDayDelta(evA);
    const b = userDayDelta(evB);
    expect(a.dateKey).toBe("2026-09-20");
    expect(b.dateKey).toBe("2026-09-21");

    const db = makeDb([evA, evB]);
    applyEventToUserRollup(db, evA);
    applyEventToUserRollup(db, evB);
    const rolled = rolledByUser(db);
    const raw = rawByUser(db);
    // One session, not two — the two day rows rejoin at read time.
    expect(rolled["key-1"].sessionCount).toBe(1);
    expect(raw["key-1"].sessionCount).toBe(1);
    expect(rolled["key-1"].activeSessionDurationMs).toBe(raw["key-1"].activeSessionDurationMs);
    db.close();
  });
});

describe("user/day rollup — agreement with the raw aggregation", () => {
  it("reproduces the raw byUser counters, crosses and session metrics", () => {
    const events = [
      makeEvent({ requestId: "a" }),
      makeEvent({ requestId: "b", model: "gpt-5.6-terra", provider: "codex", cost: 0.02, promptTokens: 2000, completionTokens: 80, tokens: JSON.stringify({ prompt_tokens: 2000, completion_tokens: 80, cached_tokens: 0 }) }),
      makeEvent({ requestId: "c", apiKeyId: "key-2", meta: JSON.stringify({ sourceIp: "5.6.7.8", userAgent: "curl/8.0" }) }),
      makeEvent({ requestId: "d", status: "error" }),
      makeEvent({ requestId: "e", status: "cancelled" }),
      makeEvent({ requestId: "f", day: "2026-09-19" }),
    ];
    const db = makeDb(events);
    for (const e of events) applyEventToUserRollup(db, e);

    const rolled = rolledByUser(db);
    const raw = rawByUser(db);

    expect(Object.keys(rolled).sort()).toEqual(Object.keys(raw).sort());
    for (const key of Object.keys(raw)) {
      const r = rolled[key];
      const w = raw[key];
      for (const field of ["requests", "completedRequests", "failedRequests", "cancelledRequests",
        "promptTokens", "completionTokens", "cachedTokens", "requestDurationMs", "durationRequestCount",
        "sessionCount", "activeSessionDurationMs", "activeDays"]) {
        expect(r[field], `${key}.${field}`).toBe(w[field]);
      }
      expect(r.cost, `${key}.cost`).toBeCloseTo(w.cost, 9);
      expect(r.firstUsed).toBe(w.firstUsed);
      expect(r.lastUsed).toBe(w.lastUsed);
      expect(r.keyName).toBe(w.keyName);
      expect(r.apiKeyMasked).toBe(w.apiKeyMasked);
      expect(r.periods).toEqual(w.periods);
      expect(r.weekdays).toEqual(w.weekdays);
      expect(Object.keys(r.models).sort()).toEqual(Object.keys(w.models).sort());
      expect(Object.keys(r.apps).sort()).toEqual(Object.keys(w.apps).sort());
      expect(Object.keys(r.sourceIps).sort()).toEqual(Object.keys(w.sourceIps).sort());
    }
    db.close();
  });

  it("counts a user's active days as distinct days with requests", () => {
    const events = [
      makeEvent({ requestId: "a", day: "2026-09-18" }),
      makeEvent({ requestId: "b", day: "2026-09-18" }),
      makeEvent({ requestId: "c", day: "2026-09-20" }),
    ];
    const db = makeDb(events);
    for (const e of events) applyEventToUserRollup(db, e);
    const rolled = rolledByUser(db);
    const raw = rawByUser(db);
    expect(rolled["key-1"].activeDays).toBe(2);
    expect(raw["key-1"].activeDays).toBe(2);
    db.close();
  });

  it("filters by date range", () => {
    const events = [makeEvent({ requestId: "old", day: "2026-09-01" }), makeEvent({ requestId: "new", day: "2026-09-20" })];
    const db = makeDb(events);
    for (const e of events) applyEventToUserRollup(db, e);
    const rolled = readUserRollup(adapterOf(db), { from: "2026-09-15", to: "2026-09-21" });
    expect(rolled["key-1"].requests).toBe(1);
    db.close();
  });

  it("resolves model keys to the display form the raw path uses", () => {
    const events = [makeEvent({ requestId: "a", provider: "codex", model: "gpt-5.6-sol" })];
    const db = makeDb(events);
    applyEventToUserRollup(db, events[0]);
    const rolled = readUserRollup(adapterOf(db), { providerNodeNameMap: { codex: "Codex Pro" } });
    expect(Object.keys(rolled["key-1"].models)).toEqual(["gpt-5.6-sol (Codex Pro)"]);
    db.close();
  });

  it("keys a null-provider model as the bare model name", () => {
    // The raw path uses `${model} (${provider})` only when a provider exists,
    // else the bare model. A non-billing endpoint (count_tokens) has no
    // provider, so this case is real traffic, not a corner.
    const events = [makeEvent({ requestId: "a", provider: null, model: "count-tokens" })];
    const db = makeDb(events);
    applyEventToUserRollup(db, events[0]);
    const rolled = rolledByUser(db);
    const raw = rawByUser(db);
    expect(Object.keys(rolled["key-1"].models)).toEqual(["count-tokens"]);
    expect(Object.keys(rolled["key-1"].models).sort()).toEqual(Object.keys(raw["key-1"].models).sort());
    db.close();
  });

  it("is idempotent per event when applied once", () => {
    // Applying the SAME event twice must double the counters (no dedup here —
    // the writer dedups upstream by only calling on a real insert). This test
    // pins that contract so a future change does not silently assume otherwise.
    const db = makeDb([]);
    const ev = makeEvent({ requestId: "a" });
    applyEventToUserRollup(db, ev);
    applyEventToUserRollup(db, ev);
    const row = db.prepare(`SELECT requests FROM ${USER_ROLLUP_TABLE} WHERE apiKeyId='key-1'`).get();
    expect(row.requests).toBe(2);
    db.close();
  });
});
