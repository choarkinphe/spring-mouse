import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  applyEventToRollup,
  ensureRollupTable,
  rollupBucketsForEvent,
  ROLLUP_TABLE,
  ROLLUP_DIMENSIONS,
  COUNTER_COLUMNS,
} from "../../runtime/usage-rollup.mjs";
import { runAggregation } from "../../runtime/usage-aggregate.mjs";

/**
 * The rollup exists to answer the same questions as the raw aggregation, faster.
 * Its only correctness property that matters is: for the counters it stores, it
 * must agree with what scanning `usageHistory` produces. These tests assert
 * exactly that, on the same event set, so a drift shows up here rather than as a
 * discrepancy between the history and live views.
 */

function makeEvent(overrides = {}) {
  return {
    requestId: overrides.requestId || `req-${Math.random().toString(36).slice(2, 10)}`,
    timestamp: "2026-09-20T10:00:00.000Z",
    startedAt: "2026-09-20T10:00:00.000Z",
    completedAt: "2026-09-20T10:00:05.000Z",
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

// Insert the events into a real usageHistory table and run the raw aggregation.
function rawAggregate(events) {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE usageHistory (
    id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT, provider TEXT, model TEXT,
    connectionId TEXT, apiKey TEXT, apiKeyId TEXT, requestId TEXT, trafficRequestId TEXT,
    startedAt TEXT, completedAt TEXT, endpoint TEXT, promptTokens INTEGER, completionTokens INTEGER,
    cost REAL, status TEXT, tokens TEXT, meta TEXT)`);
  // The aggregation reads networkTraffic too; an empty one is fine.
  db.exec(`CREATE TABLE networkTraffic (
    id INTEGER PRIMARY KEY AUTOINCREMENT, requestId TEXT UNIQUE, timestamp TEXT, completedAt TEXT,
    method TEXT, endpoint TEXT, statusCode INTEGER, requestBytes INTEGER, responseBytes INTEGER,
    durationMs INTEGER, aborted INTEGER, meta TEXT)`);

  const insert = db.prepare(
    `INSERT INTO usageHistory(timestamp, provider, model, connectionId, apiKeyId, requestId, startedAt, completedAt, endpoint, promptTokens, completionTokens, cost, status, tokens, meta)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const e of events) {
    insert.run(
      e.timestamp, e.provider, e.model, e.connectionId, e.apiKeyId, e.requestId, e.startedAt, e.completedAt,
      e.endpoint, e.promptTokens, e.completionTokens, e.cost, e.status, e.tokens, e.meta,
    );
  }

  const adapter = {
    all: (sql, params = []) => db.prepare(sql).all(...params),
    get: (sql, params = []) => db.prepare(sql).get(...params),
    iterate: (sql, params = []) => db.prepare(sql).iterate(...params),
  };
  const stats = runAggregation(adapter, { period: "all", range: {}, connectionMap: {}, apiKeyMap: {}, providerNodeNameMap: {}, sourceCapture: {}, now: new Date("2026-09-21T00:00:00Z") });
  db.close();
  return stats;
}

// Apply the same events to the rollup and read the counters back per dimension.
function rollupTotals(events) {
  const db = new DatabaseSync(":memory:");
  ensureRollupTable(db);
  for (const e of events) applyEventToRollup(db, e);

  const sums = {};
  for (const dim of ["provider", "model", "account", "apiKey", "endpoint", "sourceIp", "app", "user"]) {
    const row = db.prepare(
      `SELECT SUM(requests) r, SUM(promptTokens) p, SUM(completionTokens) c, SUM(cachedTokens) k, SUM(cost) cost
         FROM ${ROLLUP_TABLE} WHERE dimension = ?`,
    ).get(dim);
    sums[dim] = { requests: row.r || 0, promptTokens: row.p || 0, completionTokens: row.c || 0, cachedTokens: row.k || 0, cost: row.cost || 0 };
  }
  db.close();
  return sums;
}

// Total the raw aggregation's per-dimension buckets into one number per dimension.
function rawTotals(stats) {
  const out = {};
  for (const [dim, key] of [["provider", "byProvider"], ["model", "byModel"], ["account", "byAccount"], ["apiKey", "byApiKey"], ["endpoint", "byEndpoint"], ["sourceIp", "bySourceIp"], ["app", "byApp"], ["user", "byUser"]]) {
    const buckets = Object.values(stats[key] || {});
    out[dim] = {
      requests: buckets.reduce((s, b) => s + (b.requests || 0), 0),
      promptTokens: buckets.reduce((s, b) => s + (b.promptTokens || 0), 0),
      completionTokens: buckets.reduce((s, b) => s + (b.completionTokens || 0), 0),
      cachedTokens: buckets.reduce((s, b) => s + (b.cachedTokens || 0), 0),
      cost: buckets.reduce((s, b) => s + (b.cost || 0), 0),
    };
  }
  return out;
}

describe("usage rollup", () => {
  it("agrees with the raw aggregation on every dimension's totals", () => {
    const events = [
      makeEvent({ requestId: "a" }),
      makeEvent({ requestId: "b", model: "gpt-5.6-terra", provider: "codex", cost: 0.02, promptTokens: 2000, completionTokens: 80, tokens: JSON.stringify({ prompt_tokens: 2000, completion_tokens: 80, cached_tokens: 0 }) }),
      makeEvent({ requestId: "c", provider: "deepseek", model: "deepseek-v4-flash", connectionId: "conn-2", apiKeyId: "key-2", cost: 0.005, meta: JSON.stringify({ sourceIp: "5.6.7.8", userAgent: "curl/8.0" }) }),
      makeEvent({ requestId: "d", connectionId: null, meta: JSON.stringify({ userAgent: "Cursor/1.0" }) }),
    ];

    const raw = rawTotals(rawAggregate(events));
    const rolled = rollupTotals(events);

    for (const dim of Object.keys(raw)) {
      // Integers must match exactly.
      expect(rolled[dim].requests, `dimension ${dim} requests`).toBe(raw[dim].requests);
      expect(rolled[dim].promptTokens, `dimension ${dim} promptTokens`).toBe(raw[dim].promptTokens);
      expect(rolled[dim].completionTokens, `dimension ${dim} completionTokens`).toBe(raw[dim].completionTokens);
      expect(rolled[dim].cachedTokens, `dimension ${dim} cachedTokens`).toBe(raw[dim].cachedTokens);
      // Cost is REAL and the two paths sum in different orders, so compare with
      // a tolerance rather than for exact float equality.
      expect(rolled[dim].cost, `dimension ${dim} cost`).toBeCloseTo(raw[dim].cost, 9);
    }
  });

  it("emits one bucket per dimension, with raw identifiers in the key", () => {
    const buckets = rollupBucketsForEvent(makeEvent());
    const byDim = Object.fromEntries(buckets.map((b) => [b.dimension, b]));

    expect(Object.keys(byDim).sort()).toEqual([...ROLLUP_DIMENSIONS].sort());
    // Raw ids, not display names.
    expect(byDim.provider.bucketKey).toBe("codex");
    expect(byDim.user.bucketKey).toBe("key-1");
    expect(byDim.apiKey.bucketKey).toBe("key-1|gpt-5.6-sol|codex");
    expect(byDim.account.bucketKey).toBe("conn-1|gpt-5.6-sol|codex");
    expect(byDim.endpoint.bucketKey).toBe("/v1/chat/completions|gpt-5.6-sol|codex");
    expect(byDim.sourceIp.bucketKey).toBe("1.2.3.4");
  });

  it("includes the provider in the model key, so the same model on different channels stays separate", () => {
    // The raw path buckets by `${model} (${provider})`. Keying on the model
    // alone silently merged them: on production `deepseek-v4.1-flash` is served
    // by 6 providers, so the merged bucket lost the per-channel split.
    const a = rollupBucketsForEvent(makeEvent({ model: "deepseek-v4.1-flash", provider: "codebuddy-intl" }));
    const b = rollupBucketsForEvent(makeEvent({ model: "deepseek-v4.1-flash", provider: "deepseek" }));

    const keyOf = (buckets) => buckets.find((x) => x.dimension === "model").bucketKey;
    expect(keyOf(a)).toBe("deepseek-v4.1-flash|codebuddy-intl");
    expect(keyOf(b)).toBe("deepseek-v4.1-flash|deepseek");
    expect(keyOf(a)).not.toBe(keyOf(b));
  });

  it("skips dimensions that have no value for the event", () => {
    // No connectionId and no sourceIp.
    const buckets = rollupBucketsForEvent(makeEvent({ connectionId: null, meta: JSON.stringify({ userAgent: "x" }) }));
    const dims = buckets.map((b) => b.dimension);
    expect(dims).not.toContain("account");
    expect(dims).not.toContain("sourceIp");
    expect(dims).toContain("provider");
    expect(dims).toContain("user");
  });

  it("buckets a null provider as 'null', matching the raw aggregation", () => {
    // The raw path indexes byProvider[r.provider] unconditionally, so a null
    // provider (non-billing endpoints like count_tokens) becomes a "null"
    // bucket. Verified against production: skipping it here made the two paths
    // disagree by 874 requests.
    const buckets = rollupBucketsForEvent(makeEvent({ provider: null }));
    const provider = buckets.find((b) => b.dimension === "provider");
    expect(provider).toBeDefined();
    expect(provider.bucketKey).toBe("null");
  });

  it("accumulates repeat events into one bucket", () => {
    const events = [makeEvent({ requestId: "1" }), makeEvent({ requestId: "2" }), makeEvent({ requestId: "3" })];
    const rolled = rollupTotals(events);
    expect(rolled.provider.requests).toBe(3);
    expect(rolled.provider.cost).toBeCloseTo(0.03, 9);
  });

  it("buckets by local day", () => {
    const db = new DatabaseSync(":memory:");
    ensureRollupTable(db);
    // Two events on different local days.
    applyEventToRollup(db, makeEvent({ requestId: "d1", completedAt: "2026-09-20T10:00:00.000Z" }));
    applyEventToRollup(db, makeEvent({ requestId: "d2", completedAt: "2026-09-21T10:00:00.000Z" }));

    const days = db.prepare(`SELECT DISTINCT dateKey FROM ${ROLLUP_TABLE} ORDER BY dateKey`).all().map((r) => r.dateKey);
    expect(days.length).toBe(2);
    const perDay = db.prepare(`SELECT dateKey, requests FROM ${ROLLUP_TABLE} WHERE dimension='provider' ORDER BY dateKey`).all();
    expect(perDay.every((r) => r.requests === 1)).toBe(true);
    db.close();
  });

  it("carries the counter columns the read path will need", () => {
    expect(COUNTER_COLUMNS).toEqual(["requests", "promptTokens", "completionTokens", "cachedTokens", "cost"]);
  });
});
