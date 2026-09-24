import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { runAggregation, runAggregationTotals } from "../../runtime/usage-aggregate.mjs";

/**
 * `runAggregationTotals` is the home page's aggregation: it groups in SQL instead
 * of materialising every row into JS, because a rolling 24h window is ~42k rows
 * and the window slides every 60s (so the cost recurs forever).
 *
 * The whole point is that it must be INDISTINGUISHABLE from `runAggregation` on
 * everything the home page reads — the totals, the status counts, and the map
 * keys/labels the details drawer's filter dropdowns are built from. A silent
 * drift here would show different numbers on the home page than on the board.
 */

function seed() {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE usageHistory (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT, provider TEXT, model TEXT,
    connectionId TEXT, apiKey TEXT, apiKeyId TEXT, requestId TEXT, trafficRequestId TEXT, startedAt TEXT,
    completedAt TEXT, endpoint TEXT, promptTokens INTEGER, completionTokens INTEGER, cost REAL, status TEXT, tokens TEXT, meta TEXT);
    CREATE TABLE networkTraffic (id INTEGER PRIMARY KEY AUTOINCREMENT, requestId TEXT, timestamp TEXT, completedAt TEXT,
    method TEXT, endpoint TEXT, statusCode INTEGER, requestBytes INTEGER, responseBytes INTEGER, durationMs INTEGER, aborted INTEGER, meta TEXT);`);
  const now = new Date();
  const rows = [
    // status, provider, model, conn, key, endpoint, pt, ct, cost, cached, ip, geo, app, ua
    ["success", "codex", "gpt-5", "c1", "key-a", "/v1/chat", 100, 50, 0.01, 20, "1.1.1.1", "JP", "Cursor", "cursor/1"],
    ["error", "codex", "gpt-5", "c1", "key-a", "/v1/chat", 200, 80, 0.02, 0, "1.1.1.1", "JP", "Cursor", "cursor/1"],
    ["cancelled", "deepseek", "ds", "c2", "key-b", "/v1/messages", 300, 120, 0.03, 40, "2.2.2.2", "US", "curl", "curl/8"],
    ["blocked:account_locked", "deepseek", "ds", "c2", "key-b", "/v1/messages", 10, 5, 0.001, 0, "2.2.2.2", "US", "curl", "curl/8"],
    // No appName — detectSourceApp must fall back to the user-agent.
    ["upstream:503", "glm", "glm-5", "c3", null, "/v1/chat", 0, 0, 0, 0, null, null, null, null],
    ["success", "glm", "glm-5", "c3", "key-a", "/v1/chat", 400, 160, 0.04, 60, "3.3.3.3", "CN", "Cline", "cline/1"],
    // Two rows in the SAME group that differ only in tokens: one metered, one not.
    // Grouping must not collapse the metered count.
    ["success", "glm", "glm-5", "c3", "key-a", "/v1/chat", 0, 0, 0, 0, "3.3.3.3", "CN", "Cline", "cline/1"],
    ["success", "glm", "glm-5", "c3", "key-a", "/v1/chat", 7, 3, 0.005, 0, "3.3.3.3", "CN", "Cline", "cline/1"],
  ];
  rows.forEach(([status, provider, model, conn, key, ep, pt, ct, cost, cached, ip, geo, app, ua], i) => {
    const ts = new Date(now.getTime() - (i + 1) * 60_000).toISOString();
    db.prepare(`INSERT INTO usageHistory(timestamp,provider,model,connectionId,apiKeyId,requestId,startedAt,completedAt,endpoint,promptTokens,completionTokens,cost,status,tokens,meta) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(ts, provider, model, conn, key, "r" + i, ts, ts, ep, pt, ct, cost, status,
        JSON.stringify({ prompt_tokens: pt, completion_tokens: ct, cached_tokens: cached }),
        JSON.stringify({ sourceIp: ip, sourceGeo: geo, appName: app, userAgent: ua }));
  });
  return {
    db,
    now,
    adapter: {
      all: (s, p = []) => db.prepare(s).all(...p),
      get: (s, p = []) => db.prepare(s).get(...p),
      iterate: (s, p = []) => db.prepare(s).iterate(...p),
    },
  };
}

const TOTAL_FIELDS = [
  "totalRequests", "completedRequests", "failedRequests", "cancelledRequests", "meteredRequests",
  "totalPromptTokens", "totalCompletionTokens", "totalCachedTokens",
  "totalRequestBytes", "totalResponseBytes", "totalTrafficBytes",
];

const MAPS = ["byProvider", "byModel", "byUser", "bySourceIp", "byApp"];

function both(overrides = {}) {
  const { db, now, adapter } = seed();
  const range = { startDate: new Date(now.getTime() - 3600e3).toISOString(), endDate: now.toISOString() };
  const apiKeyMap = { "key-a": { name: "Alpha", id: "key-a" }, "key-b": { name: "Beta", id: "key-b" } };
  const params = { period: "today", range, apiKeyMap, providerNodeNameMap: {}, sourceCapture: {}, ...overrides };
  const raw = runAggregation(adapter, { ...params, connectionMap: {}, now });
  const totals = runAggregationTotals(adapter, params);
  return { db, raw, totals };
}

describe("runAggregationTotals agrees with runAggregation", () => {
  it("matches every total the home page's cards read", () => {
    const { db, raw, totals } = both();
    for (const field of TOTAL_FIELDS) expect(totals[field], field).toBe(raw[field]);
    expect(Math.abs(totals.totalCost - raw.totalCost)).toBeLessThan(1e-9);
    db.close();
  });

  it("counts metered requests per ROW, not per group", () => {
    // A group is rows sharing the grouping columns, and `tokens` is not one of
    // them — so a group can hold both metered and unmetered rows. Counting the
    // group's `requests` would over-report.
    const { db, raw, totals } = both();
    expect(totals.meteredRequests).toBe(raw.meteredRequests);
    db.close();
  });

  it("builds the same map keys and per-key totals the drawer filters on", () => {
    const { db, raw, totals } = both();
    for (const map of MAPS) {
      expect(Object.keys(totals[map]).sort(), `${map} keys`).toEqual(Object.keys(raw[map]).sort());
      for (const key of Object.keys(raw[map])) {
        for (const field of ["requests", "promptTokens", "completionTokens", "cachedTokens"]) {
          expect(totals[map][key][field], `${map}[${key}].${field}`).toBe(raw[map][key][field]);
        }
        expect(Math.abs((totals[map][key].cost || 0) - (raw[map][key].cost || 0)), `${map}[${key}].cost`).toBeLessThan(1e-9);
      }
    }
    db.close();
  });

  it("keeps the drawer's display labels identical to the raw path", () => {
    const { db, raw, totals } = both();
    for (const map of ["byUser", "byModel", "byApp", "bySourceIp"]) {
      for (const key of Object.keys(raw[map])) {
        for (const field of ["keyName", "userId", "rawModel", "appName", "sourceIp", "apiKeyMasked"]) {
          if (field in raw[map][key]) {
            expect(totals[map][key][field], `${map}[${key}].${field}`).toBe(raw[map][key][field]);
          }
        }
      }
    }
    db.close();
  });

  it("honours an apiKey scope", () => {
    const s = seed();
    const range = { startDate: new Date(s.now.getTime() - 3600e3).toISOString(), endDate: s.now.toISOString(), apiKeyId: "key-a" };
    const apiKeyMap = { "key-a": { name: "Alpha", id: "key-a" } };
    const p = { period: "today", range, apiKeyMap, providerNodeNameMap: {}, sourceCapture: {} };
    const raw = runAggregation(s.adapter, { ...p, connectionMap: {}, now: s.now });
    const totals = runAggregationTotals(s.adapter, p);
    expect(totals.totalRequests).toBe(raw.totalRequests);
    expect(Object.keys(totals.byUser)).toEqual(Object.keys(raw.byUser));
    // Scoped to one key, so only that key appears.
    expect(Object.keys(totals.byUser)).toEqual(["key-a"]);
    s.db.close();
  });
});
