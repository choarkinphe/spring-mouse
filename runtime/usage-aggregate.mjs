/**
 * Shared usage-aggregation core.
 *
 * WHY THIS FILE IS IN `runtime/` AND NOT `src/`:
 * The Docker image only ships `runtime/` as a real directory (Dockerfile:100).
 * `src/lib/db/repos/usageRepo.js` is bundled into `.next/server/chunks/`, so it
 * does not exist as a file at runtime and cannot be loaded by a worker. Both the
 * web process (fallback path) and `runtime/usage-aggregate-worker.mjs` import
 * this module, so the aggregation logic has exactly one implementation.
 *
 * CONSTRAINTS — keep this file dependency-free:
 *   - No `node:sqlite` import (the worker owns its connection; the web process
 *     passes its existing adapter).
 *   - No `@/` or `open-sse/` alias imports (not resolvable from `runtime/`).
 *   - Only Node built-ins and relative imports inside `runtime/`.
 *
 * The caller supplies `adapter`, an object with `{ all(sql, params), get(sql, params),
 * iterate(sql, params) }`. This mirrors `src/lib/db/adapters/nodeSqliteAdapter.js`.
 */

// ─── small helpers (self-contained copies; see file header for why) ──────────

export function parseJson(value, fallback = null) {
  if (value === null || value === undefined || value === "") return fallback;
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

export function maskApiKey(key) {
  if (!key || typeof key !== "string") return null;
  if (key.length <= 8) return key.charAt(0) + "***";
  return key.slice(0, 8) + "***";
}

const PERIOD_MS = { "24h": 86400000, "7d": 604800000, "30d": 2592000000, "60d": 5184000000 };

// Keep in sync with src/shared/utils/requestSource.js (detectSourceApp).
//
// Hoisted out of the function: this runs once per row (~41k for the home page's
// 24h window), and rebuilding the 17-entry table on every call was ~40ms of a
// ~2s aggregation. The table is constant, so it belongs at module scope.
const KNOWN_APPS = [
  ["claude code", ["claude-code", "claude code"]],
  ["OpenAI Codex", ["codex_cli_rs", "openai codex", "codex-cli"]],
  ["Cursor", ["cursor"]],
  ["Cline", ["cline"]],
  ["Roo Code", ["roo-code", "roo code"]],
  ["Continue", ["continue.dev", "continue/"]],
  ["Aider", ["aider"]],
  ["Open WebUI", ["open-webui", "openwebui"]],
  ["LobeChat", ["lobechat", "lobe-chat"]],
  ["Chatbox", ["chatbox"]],
  ["Cherry Studio", ["cherry studio", "cherry-studio"]],
  ["NextChat", ["nextchat", "chatgpt-next-web"]],
  ["VS Code", ["vscode", "visual studio code"]],
  ["JetBrains", ["jetbrains", "intellij", "pycharm", "webstorm"]],
  ["OpenAI Python SDK", ["openai-python", "python-openai"]],
  ["OpenAI Node SDK", ["openai-node", "node-openai"]],
  ["curl", ["curl/"]],
];

export function detectSourceApp({ appName, userAgent, sourceUrl } = {}) {
  if (appName) return appName;
  const haystack = `${userAgent || ""} ${sourceUrl || ""}`.toLowerCase();
  for (const [label, needles] of KNOWN_APPS) {
    if (needles.some((needle) => haystack.includes(needle))) return label;
  }
  if (userAgent) return userAgent.split(/[ /]/)[0].slice(0, 48) || "未知客户端";
  return "未知客户端";
}

export function getUsageUserName(apiKeyId, apiKeyMap = {}) {
  if (apiKeyMap[apiKeyId]?.name) return apiKeyMap[apiKeyId].name;
  if (apiKeyId === "local-no-key" || !apiKeyId) return "本地（未带 Key）";
  if (typeof apiKeyId === "string" && apiKeyId.startsWith("external:")) return "外部 API Key";
  return "已删除 API Key";
}

function getLocalDateKey(timestamp) {
  const d = timestamp ? new Date(timestamp) : new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function getRequestDurationMs(startedAt, completedAt) {
  const start = new Date(startedAt).getTime();
  const end = new Date(completedAt).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return 0;
  return end - start;
}

/**
 * Is `candidate` a later timestamp than `current`?
 *
 * Timestamps are stored as ISO-8601 UTC strings ("2026-09-23T07:22:17.746Z"), and
 * for that fixed-width, zero-padded, same-zone form lexicographic order IS
 * chronological order. Comparing the strings avoids two `new Date()` allocations
 * per call.
 *
 * WHY IT MATTERS: this runs per row per dimension — 6 dimensions x ~41k rows for
 * the home page's 24h window — so the naive `new Date(a) > new Date(b)` form cost
 * ~700ms of a ~2s aggregation (measured on production). The string form is ~13x
 * cheaper (215ms -> 16ms over the same rows).
 *
 * A non-ISO value (legacy row, or one carrying an offset) would not sort
 * correctly as a string, so anything not matching the canonical shape falls back
 * to parsing. That keeps this a pure optimisation: correctness never depends on
 * the storage format holding.
 */
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

export function isLaterTimestamp(candidate, current) {
  if (typeof candidate !== "string" || typeof current !== "string") {
    return new Date(candidate) > new Date(current);
  }
  if (ISO_UTC.test(candidate) && ISO_UTC.test(current)) return candidate > current;
  return new Date(candidate) > new Date(current);
}

export function getUsageApiKeyFilter(range = {}, column = "apiKeyId") {
  const scopedApiKeyIds = Array.isArray(range.apiKeyIds)
    ? [...new Set(range.apiKeyIds.filter((id) => typeof id === "string" && id))]
    : null;
  const apiKeyIds = range.apiKeyId
    ? (scopedApiKeyIds === null || scopedApiKeyIds.includes(range.apiKeyId) ? [range.apiKeyId] : [])
    : scopedApiKeyIds;

  if (apiKeyIds === null) return { clause: "", params: [] };
  if (apiKeyIds.length === 0) return { clause: "0 = 1", params: [] };
  return { clause: `${column} IN (${apiKeyIds.map(() => "?").join(", ")})`, params: apiKeyIds };
}

export function appendUsageApiKeyFilter(conditions, params, range = {}, column = "apiKeyId") {
  const filter = getUsageApiKeyFilter(range, column);
  if (filter.clause) {
    conditions.push(filter.clause);
    params.push(...filter.params);
  }
  return filter;
}

function addToCounter(target, key, values) {
  if (!target[key]) target[key] = { requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0 };
  target[key].requests += values.requests || 1;
  target[key].promptTokens += values.promptTokens || 0;
  target[key].completionTokens += values.completionTokens || 0;
  target[key].cachedTokens += values.cachedTokens || 0;
  target[key].cost += values.cost || 0;
  if (values.meta) Object.assign(target[key], values.meta);
}

function addPersonUsage(target, key, values, meta = {}) {
  if (!target[key]) {
    target[key] = {
      requests: 0,
      completedRequests: 0,
      failedRequests: 0,
      cancelledRequests: 0,
      promptTokens: 0,
      completionTokens: 0,
      cachedTokens: 0,
      cost: 0,
      requestDurationMs: 0,
      durationRequestCount: 0,
      models: {},
      sourceIps: {},
      apps: {},
      periods: Array(6).fill(0),
      weekdays: Array(7).fill(0),
      firstUsed: null,
      lastUsed: null,
      ...meta,
    };
  }

  const person = target[key];
  person.requests += values.requests || 1;
  person.promptTokens += values.promptTokens || 0;
  person.completionTokens += values.completionTokens || 0;
  person.cachedTokens += values.cachedTokens || 0;
  person.cost += values.cost || 0;

  const status = values.status || "success";
  if (status === "cancelled") person.cancelledRequests += values.requests || 1;
  else if (status === "error") person.failedRequests += values.requests || 1;
  else person.completedRequests += values.requests || 1;

  const durationMs = Number.isFinite(values.durationMs) ? Math.max(0, values.durationMs) : 0;
  if (durationMs > 0) {
    person.requestDurationMs += durationMs;
    person.durationRequestCount += values.requests || 1;
  }

  const timestamp = values.timestamp || null;
  if (timestamp && (!person.firstUsed || timestamp < person.firstUsed)) person.firstUsed = timestamp;
  if (timestamp && (!person.lastUsed || timestamp > person.lastUsed)) person.lastUsed = timestamp;

  if (values.model) addToCounter(person.models, values.model, values);
  if (values.sourceIp) addToCounter(person.sourceIps, values.sourceIp, values);
  if (values.appName) addToCounter(person.apps, values.appName, values);
  if (Number.isInteger(values.periodBucket)) person.periods[values.periodBucket] += values.requests || 1;
  if (Number.isInteger(values.weekdayBucket)) person.weekdays[values.weekdayBucket] += values.requests || 1;
}

/**
 * Session metrics need per-event timestamps (a >30min gap starts a new session),
 * so they cannot be derived from any day-grain rollup. Kept here so the worker
 * computes them from a slim projection instead of the full row scan.
 */
function finalizePersonSessionMetrics(byUser, personEvents) {
  const sessionGapMs = 30 * 60 * 1000;

  for (const [personKey, events] of personEvents.entries()) {
    const person = byUser[personKey];
    if (!person || !events.length) continue;

    const ordered = events
      .filter((event) => Number.isFinite(event.startedAt))
      .sort((a, b) => a.startedAt - b.startedAt);
    const activeDays = new Set();
    let sessionCount = 0;
    let sessionDurationMs = 0;
    let sessionStart = null;
    let sessionEnd = null;

    const closeSession = () => {
      if (sessionStart === null || sessionEnd === null) return;
      sessionCount += 1;
      sessionDurationMs += Math.max(0, sessionEnd - sessionStart);
    };

    for (const event of ordered) {
      activeDays.add(getLocalDateKey(new Date(event.startedAt).toISOString()));
      const eventEnd = Math.max(event.startedAt, event.completedAt || event.startedAt);

      if (sessionStart === null) {
        sessionStart = event.startedAt;
        sessionEnd = eventEnd;
        continue;
      }

      if (event.startedAt <= sessionEnd + sessionGapMs) {
        sessionEnd = Math.max(sessionEnd, eventEnd);
        continue;
      }

      closeSession();
      sessionStart = event.startedAt;
      sessionEnd = eventEnd;
    }

    closeSession();
    person.sessionCount = sessionCount;
    person.activeSessionDurationMs = sessionDurationMs;
    person.activeDays = activeDays.size;
  }
}

// ─── traffic (networkTraffic) aggregation ───────────────────────────────────

function normalizeBytes(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

function startOfLocalDay(date = new Date()) {
  const value = new Date(date);
  value.setHours(0, 0, 0, 0);
  return value;
}

function currentTrafficRanges() {
  const now = new Date();
  const today = startOfLocalDay(now);
  const week = startOfLocalDay(now);
  week.setDate(week.getDate() - ((week.getDay() + 6) % 7));
  const month = startOfLocalDay(now);
  month.setDate(1);
  return { today, week, month, now };
}

function buildTrafficFilter({ startDate, endDate, apiKeyId, apiKeyIds } = {}, alias = "nt") {
  const conditions = [];
  const params = [];

  if (startDate) {
    conditions.push(`${alias}.timestamp >= ?`);
    params.push(new Date(startDate).toISOString());
  }
  if (endDate) {
    conditions.push(`${alias}.timestamp <= ?`);
    params.push(new Date(endDate).toISOString());
  }
  const scopedApiKeyIds = Array.isArray(apiKeyIds)
    ? [...new Set(apiKeyIds.filter((id) => typeof id === "string" && id))]
    : null;
  if (scopedApiKeyIds) {
    if (scopedApiKeyIds.length === 0) {
      conditions.push("0 = 1");
    } else {
      conditions.push(`EXISTS (SELECT 1 FROM usageHistory uh WHERE uh.trafficRequestId = ${alias}.requestId AND uh.apiKeyId IN (${scopedApiKeyIds.map(() => "?").join(", ")}))`);
      params.push(...scopedApiKeyIds);
    }
  } else if (apiKeyId) {
    conditions.push(`EXISTS (SELECT 1 FROM usageHistory uh WHERE uh.trafficRequestId = ${alias}.requestId AND uh.apiKeyId = ?)`);
    params.push(apiKeyId);
  }

  return { where: conditions.length ? `WHERE ${conditions.join(" AND ")}` : "", params };
}

function mapTrafficTotals(row) {
  const requestBytes = normalizeBytes(row?.requestBytes);
  const responseBytes = normalizeBytes(row?.responseBytes);
  return {
    requests: Number(row?.requests) || 0,
    requestBytes,
    responseBytes,
    totalBytes: requestBytes + responseBytes,
  };
}

export function getTrafficTotals(adapter, range = {}) {
  const { where, params } = buildTrafficFilter(range);
  const row = adapter.get(
    `SELECT COUNT(*) AS requests, COALESCE(SUM(requestBytes), 0) AS requestBytes, COALESCE(SUM(responseBytes), 0) AS responseBytes
       FROM networkTraffic nt ${where}`,
    params,
  );
  return mapTrafficTotals(row);
}

export function getTrafficSummary(adapter, { apiKeyId = null, apiKeyIds = null, recentLimit = 12 } = {}) {
  const { today, week, month, now } = currentTrafficRanges();
  const endDate = now.toISOString();

  const todayTotals = getTrafficTotals(adapter, { startDate: today.toISOString(), endDate, apiKeyId, apiKeyIds });
  const weekTotals = getTrafficTotals(adapter, { startDate: week.toISOString(), endDate, apiKeyId, apiKeyIds });
  const monthTotals = getTrafficTotals(adapter, { startDate: month.toISOString(), endDate, apiKeyId, apiKeyIds });

  const { where, params } = buildTrafficFilter({ apiKeyId, apiKeyIds });
  const recent = adapter.all(
    `SELECT requestId, timestamp, completedAt, method, endpoint, statusCode, requestBytes, responseBytes, durationMs, aborted, meta
       FROM networkTraffic nt ${where}
      ORDER BY timestamp DESC
      LIMIT ?`,
    [...params, Math.max(1, Math.min(50, Number(recentLimit) || 12))],
  ).map((row) => {
    const requestBytes = normalizeBytes(row.requestBytes);
    const responseBytes = normalizeBytes(row.responseBytes);
    const meta = parseJson(row.meta, {}) || {};
    return {
      requestId: row.requestId,
      timestamp: row.timestamp,
      completedAt: row.completedAt,
      method: row.method,
      endpoint: row.endpoint,
      statusCode: Number(row.statusCode) || 0,
      requestBytes,
      responseBytes,
      totalBytes: requestBytes + responseBytes,
      durationMs: Math.max(0, Number(row.durationMs) || 0),
      aborted: row.aborted === 1,
      appName: meta.appName || null,
    };
  });

  return { today: todayTotals, week: weekTotals, month: monthTotals, recent };
}

export function getTrafficBuckets(adapter, { startTime, endTime, bucketMs, bucketCount, apiKeyId = null, apiKeyIds = null }) {
  const startIso = new Date(startTime).toISOString();
  const endIso = new Date(endTime).toISOString();
  const { where: extraWhere, params: extraParams } = buildTrafficFilter({ apiKeyId, apiKeyIds });
  const apiKeyCondition = extraWhere ? extraWhere.replace(/^WHERE\s+/, " AND ") : "";
  const rows = adapter.all(
    `SELECT
       CAST(((julianday(nt.timestamp) - julianday(?)) * 86400000.0) / ? AS INTEGER) AS bucketIndex,
       COALESCE(SUM(nt.requestBytes), 0) AS requestBytes,
       COALESCE(SUM(nt.responseBytes), 0) AS responseBytes
     FROM networkTraffic nt
     WHERE nt.timestamp >= ? AND nt.timestamp <= ?${apiKeyCondition}
     GROUP BY bucketIndex
     ORDER BY bucketIndex`,
    [startIso, bucketMs, startIso, endIso, ...extraParams],
  );

  const buckets = Array.from({ length: bucketCount }, () => ({ requestBytes: 0, responseBytes: 0, trafficBytes: 0 }));
  for (const row of rows) {
    const index = Number(row.bucketIndex);
    if (index < 0 || index >= bucketCount) continue;
    const requestBytes = normalizeBytes(row.requestBytes);
    const responseBytes = normalizeBytes(row.responseBytes);
    buckets[index] = { requestBytes, responseBytes, trafficBytes: requestBytes + responseBytes };
  }
  return buckets;
}

// ─── usageHistory aggregation ───────────────────────────────────────────────

export function getTrafficRange(period, range = {}) {
  if (range.startDate && range.endDate) return { startDate: range.startDate, endDate: range.endDate, apiKeyId: range.apiKeyId || null, apiKeyIds: range.apiKeyIds || null };
  const endDate = new Date().toISOString();
  if (period === "today") {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    return { startDate: start.toISOString(), endDate, apiKeyId: range.apiKeyId || null, apiKeyIds: range.apiKeyIds || null };
  }
  if (PERIOD_MS[period]) return { startDate: new Date(Date.now() - PERIOD_MS[period]).toISOString(), endDate, apiKeyId: range.apiKeyId || null, apiKeyIds: range.apiKeyIds || null };
  return { apiKeyId: range.apiKeyId || null, apiKeyIds: range.apiKeyIds || null };
}

export function getRecentCallDetails(adapter, period, range, apiKeyMap, providerNodeNameMap) {
  const conditions = [];
  const params = [];

  if (range.startDate && range.endDate) {
    conditions.push("timestamp >= ?", "timestamp <= ?");
    params.push(range.startDate, range.endDate);
  } else if (period === "today") {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    conditions.push("timestamp >= ?");
    params.push(startOfDay.toISOString());
  } else if (period === "24h") {
    conditions.push("timestamp >= ?");
    params.push(new Date(Date.now() - PERIOD_MS["24h"]).toISOString());
  } else if (PERIOD_MS[period]) {
    conditions.push("timestamp >= ?");
    params.push(new Date(Date.now() - PERIOD_MS[period]).toISOString());
  }

  appendUsageApiKeyFilter(conditions, params, range);

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const rows = adapter.all(
    `SELECT id, requestId, timestamp, startedAt, completedAt, provider, model, apiKeyId AS apiKey, endpoint, promptTokens, completionTokens, cost, status, tokens, meta, trafficRequestId,
            COALESCE((SELECT requestBytes FROM networkTraffic nt WHERE nt.requestId = usageHistory.trafficRequestId), 0) AS requestBytes,
            COALESCE((SELECT responseBytes FROM networkTraffic nt WHERE nt.requestId = usageHistory.trafficRequestId), 0) AS responseBytes
       FROM usageHistory ${where} ORDER BY id DESC LIMIT 100`,
    params,
  );

  return rows.map((row) => {
    const tokens = parseJson(row.tokens, {}) || {};
    const meta = parseJson(row.meta, {}) || {};
    const keyInfo = row.apiKey ? apiKeyMap[row.apiKey] : null;
    const promptTokens = row.promptTokens ?? tokens.prompt_tokens ?? tokens.input_tokens ?? 0;
    const completionTokens = row.completionTokens ?? tokens.completion_tokens ?? tokens.output_tokens ?? 0;
    return {
      id: row.id,
      // The join key back to requestDetails (which stores the conversation).
      // `usageHistory.id` is not it — that is a local integer.
      requestId: row.requestId || null,
      timestamp: row.timestamp,
      userId: row.apiKey || "local-no-key",
      durationMs: getRequestDurationMs(row.startedAt || row.timestamp, row.completedAt || row.timestamp),
      keyName: keyInfo?.name || (row.apiKey === "local-no-key" ? "Local (No API Key)" : row.apiKey?.startsWith("external:") ? "External API Key" : "Deleted API Key"),
      apiKeyMasked: keyInfo ? null : (row.apiKey?.startsWith("external:") ? "External API Key" : null),
      model: row.model || "unknown",
      provider: providerNodeNameMap[row.provider] || row.provider || "unknown",
      appName: detectSourceApp(meta),
      sourceIp: meta.sourceIp || null,
      sourceGeo: meta.sourceGeo || null,
      endpoint: row.endpoint || "Unknown",
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
      requestBytes: Number(row.requestBytes) || 0,
      responseBytes: Number(row.responseBytes) || 0,
      totalBytes: (Number(row.requestBytes) || 0) + (Number(row.responseBytes) || 0),
      cost: row.cost || 0,
      status: row.status || "ok",
    };
  });
}

/**
 * The last 100 calls, deduped to 50 — the home page's "最近的请求" card.
 * Cheap and independent of the range, so both the raw and rollup-backed
 * aggregations reuse it.
 */
export function buildRecentRequests(adapter, range, apiKeyMap) {
  const usageApiKeyFilter = getUsageApiKeyFilter(range);
  const scopedWhere = usageApiKeyFilter.clause ? ` WHERE ${usageApiKeyFilter.clause}` : "";
  const recentRows = adapter.all(
    `SELECT timestamp, provider, model, apiKeyId, tokens, status FROM usageHistory${scopedWhere} ORDER BY id DESC LIMIT 100`,
    usageApiKeyFilter.params,
  );
  const seen = new Set();
  return recentRows
    .map((r) => {
      const t = parseJson(r.tokens, {}) || {};
      return {
        timestamp: r.timestamp, model: r.model, provider: r.provider || "",
        apiKeyId: r.apiKeyId || "local-no-key",
        userName: getUsageUserName(r.apiKeyId || "local-no-key", apiKeyMap),
        promptTokens: t.prompt_tokens || t.input_tokens || 0,
        completionTokens: t.completion_tokens || t.output_tokens || 0,
        cachedTokens: t.cached_tokens || t.cache_read_input_tokens || 0,
        status: r.status || "ok",
      };
    })
    .filter((e) => {
      if (e.promptTokens === 0 && e.completionTokens === 0) return false;
      const minute = e.timestamp ? e.timestamp.slice(0, 16) : "";
      const key = `${e.apiKeyId}|${e.model}|${e.provider}|${e.promptTokens}|${e.completionTokens}|${minute}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 50);
}

/**
 * Ten one-minute buckets over the last 10 minutes, with traffic merged in.
 * A fixed recent window, so it stays on the raw table in both modes.
 */
export function buildLast10Minutes(adapter, range, now) {
  const currentMinuteStart = new Date(Math.floor(now.getTime() / 60000) * 60000);
  const tenMinutesAgo = new Date(currentMinuteStart.getTime() - 9 * 60 * 1000);
  const bucketMap = {};
  const buckets = [];
  for (let i = 0; i < 10; i++) {
    const ts = currentMinuteStart.getTime() - (9 - i) * 60 * 1000;
    bucketMap[ts] = { requests: 0, promptTokens: 0, completionTokens: 0, cost: 0 };
    buckets.push(bucketMap[ts]);
  }
  const recent10Conditions = ["timestamp >= ?", "timestamp <= ?"];
  const recent10Params = [tenMinutesAgo.toISOString(), now.toISOString()];
  appendUsageApiKeyFilter(recent10Conditions, recent10Params, range);
  const recent10 = adapter.all(
    `SELECT timestamp, promptTokens, completionTokens, cost FROM usageHistory WHERE ${recent10Conditions.join(" AND ")}`,
    recent10Params,
  );
  for (const r of recent10) {
    const tt = new Date(r.timestamp).getTime();
    const minuteStart = Math.floor(tt / 60000) * 60000;
    if (bucketMap[minuteStart]) {
      bucketMap[minuteStart].requests++;
      bucketMap[minuteStart].promptTokens += r.promptTokens || 0;
      bucketMap[minuteStart].completionTokens += r.completionTokens || 0;
      bucketMap[minuteStart].cost += r.cost || 0;
    }
  }
  const recentTraffic = getTrafficBuckets(adapter, {
    startTime: tenMinutesAgo.getTime(),
    endTime: now.getTime(),
    bucketMs: 60 * 1000,
    bucketCount: 10,
    apiKeyId: range.apiKeyId || null,
    apiKeyIds: range.apiKeyIds || null,
  });
  buckets.forEach((bucket, index) => Object.assign(bucket, recentTraffic[index] || {
    requestBytes: 0,
    responseBytes: 0,
    trafficBytes: 0,
  }));
  return buckets;
}

/** An empty stats object with every field the dashboard contract promises. */
export function emptyStats(sourceCapture = {}, recentRequests = []) {
  return {
    totalRequests: 0,
    completedRequests: 0, failedRequests: 0, cancelledRequests: 0, meteredRequests: 0,
    totalPromptTokens: 0, totalCompletionTokens: 0, totalCachedTokens: 0, totalCost: 0,
    totalRequestBytes: 0, totalResponseBytes: 0, totalTrafficBytes: 0,
    trafficSummary: { today: { requests: 0, requestBytes: 0, responseBytes: 0, totalBytes: 0 }, week: { requests: 0, requestBytes: 0, responseBytes: 0, totalBytes: 0 }, month: { requests: 0, requestBytes: 0, responseBytes: 0, totalBytes: 0 }, recent: [] },
    byProvider: {}, byModel: {}, byAccount: {}, byApiKey: {}, byEndpoint: {}, bySourceIp: {}, byApp: {}, byUser: {},
    sourceCapture,
    requestRhythm: {
      periods: ["00:00–03:59", "04:00–07:59", "08:00–11:59", "12:00–15:59", "16:00–19:59", "20:00–23:59"].map((label) => ({ label, requests: 0 })),
      weekdays: ["周一", "周二", "周三", "周四", "周五", "周六", "周日"].map((label) => ({ label, requests: 0 })),
    },
    last10Minutes: [],
    recentCallDetails: [],
    pending: {},
    activeRequests: [],
    recentRequests,
    errorProvider: "",
  };
}

/**
 * Build the stats object. Mirrors the pre-existing `calculateUsageStats` body
 * exactly (minus the three live fields the caller overlays), so the dashboard
 * contract is unchanged.
 *
 * @param {object} adapter  { all, get, iterate }
 * @param {object} params   { period, range, connectionMap, apiKeyMap,
 *                            providerNodeNameMap, sourceCapture }
 */
export function runAggregation(adapter, {
  period = "all",
  range = {},
  connectionMap = {},
  apiKeyMap = {},
  providerNodeNameMap = {},
  sourceCapture = {},
  now = new Date(),
} = {}) {
  const recentRequests = buildRecentRequests(adapter, range, apiKeyMap);
  const stats = emptyStats(sourceCapture, recentRequests);
  stats.last10Minutes = buildLast10Minutes(adapter, range, now);
  stats.recentCallDetails = getRecentCallDetails(adapter, period, range, apiKeyMap, providerNodeNameMap);

  // Live-history aggregation (the authoritative path; the day-grain rollup was
  // abandoned — see the plan doc — because session metrics need event timestamps).
  let cutoff;
  let endDate = null;
  if (range.startDate && range.endDate) {
    cutoff = range.startDate;
    endDate = range.endDate;
  } else if (period === "today") {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    cutoff = startOfDay.toISOString();
  } else if (PERIOD_MS[period]) {
    cutoff = new Date(Date.now() - PERIOD_MS[period]).toISOString();
  } else {
    cutoff = new Date(0).toISOString();
  }
  const historyConditions = endDate ? ["timestamp >= ?", "timestamp <= ?"] : ["timestamp >= ?"];
  const historyParams = endDate ? [cutoff, endDate] : [cutoff];
  appendUsageApiKeyFilter(historyConditions, historyParams, range);
  const filtered = adapter.iterate(
    `SELECT timestamp, startedAt, completedAt, provider, model, connectionId, apiKeyId AS apiKey, endpoint, promptTokens, completionTokens, cost, status, tokens, meta FROM usageHistory WHERE ${historyConditions.join(" AND ")}`,
    historyParams,
  );

  const personEvents = new Map();
  for (const r of filtered) {
    const tokens = parseJson(r.tokens, {}) || {};
    const promptTokens = tokens.prompt_tokens || 0;
    const completionTokens = tokens.completion_tokens || 0;
    const cachedTokens = tokens.cached_tokens || tokens.cache_read_input_tokens || 0;
    const entryCost = r.cost || 0;
    const providerDisplayName = providerNodeNameMap[r.provider] || r.provider;
    const requestMeta = parseJson(r.meta, {}) || {};
    const sourceIp = requestMeta.sourceIp || null;
    const sourceGeo = requestMeta.sourceGeo || null;
    const appName = detectSourceApp(requestMeta);

    if (r.status === "cancelled") stats.cancelledRequests++;
    else if (r.status === "error") stats.failedRequests++;
    else stats.completedRequests++;
    if (promptTokens > 0 || completionTokens > 0) stats.meteredRequests++;
    stats.totalPromptTokens += promptTokens;
    stats.totalCompletionTokens += completionTokens;
    stats.totalCachedTokens += cachedTokens;
    stats.totalCost += entryCost;

    if (!stats.byProvider[r.provider]) stats.byProvider[r.provider] = { requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0 };
    stats.byProvider[r.provider].requests++;
    stats.byProvider[r.provider].promptTokens += promptTokens;
    stats.byProvider[r.provider].completionTokens += completionTokens;
    stats.byProvider[r.provider].cachedTokens += cachedTokens;
    stats.byProvider[r.provider].cost += entryCost;

    const modelKey = r.provider ? `${r.model} (${r.provider})` : r.model;
    if (!stats.byModel[modelKey]) {
      stats.byModel[modelKey] = { requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0, rawModel: r.model, provider: providerDisplayName, lastUsed: r.timestamp };
    }
    stats.byModel[modelKey].requests++;
    stats.byModel[modelKey].promptTokens += promptTokens;
    stats.byModel[modelKey].completionTokens += completionTokens;
    stats.byModel[modelKey].cachedTokens += cachedTokens;
    stats.byModel[modelKey].cost += entryCost;
    if (isLaterTimestamp(r.timestamp, stats.byModel[modelKey].lastUsed)) stats.byModel[modelKey].lastUsed = r.timestamp;

    if (r.connectionId) {
      const accountName = connectionMap[r.connectionId] || `Account ${r.connectionId.slice(0, 8)}...`;
      const accountKey = `${r.model} (${r.provider} - ${accountName})`;
      if (!stats.byAccount[accountKey]) {
        stats.byAccount[accountKey] = { requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0, rawModel: r.model, provider: providerDisplayName, connectionId: r.connectionId, accountName, lastUsed: r.timestamp };
      }
      stats.byAccount[accountKey].requests++;
      stats.byAccount[accountKey].promptTokens += promptTokens;
      stats.byAccount[accountKey].completionTokens += completionTokens;
      stats.byAccount[accountKey].cachedTokens += cachedTokens;
      stats.byAccount[accountKey].cost += entryCost;
      if (isLaterTimestamp(r.timestamp, stats.byAccount[accountKey].lastUsed)) stats.byAccount[accountKey].lastUsed = r.timestamp;
    }

    if (r.apiKey && r.apiKey !== "local-no-key" && typeof r.apiKey === "string") {
      const keyInfo = apiKeyMap[r.apiKey];
      const keyName = keyInfo?.name || (r.apiKey.startsWith("external:") ? "External API Key" : "Deleted API Key");
      const apiKeyMasked = keyInfo ? null : (r.apiKey?.startsWith("external:") ? "External API Key" : null);
      // Key template intentionally uses the raw r.apiKey (not apiKeyMasked): the
      // bucket is an internal grouping key, and masking is applied to the
      // displayed `apiKeyMasked` field only. Preserved from the original
      // implementation so aggregation buckets do not shift.
      const akKey = `${r.apiKey}|${r.model}|${r.provider || "unknown"}`;
      if (!stats.byApiKey[akKey]) {
        stats.byApiKey[akKey] = { requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0, rawModel: r.model, provider: providerDisplayName, apiKeyMasked, keyName, apiKeyKey: r.apiKey, lastUsed: r.timestamp };
      }
      const ake = stats.byApiKey[akKey];
      ake.requests++; ake.promptTokens += promptTokens; ake.completionTokens += completionTokens; ake.cachedTokens += cachedTokens; ake.cost += entryCost;
      if (isLaterTimestamp(r.timestamp, ake.lastUsed)) ake.lastUsed = r.timestamp;
    } else {
      // Symmetric key with the apiKey branch so local-no-key keeps per-model splits.
      const apiKeyMasked = "local-no-key";
      const akKey = `${r.apiKey}|${r.model}|${r.provider || "unknown"}`;
      if (!stats.byApiKey[akKey]) {
        stats.byApiKey[akKey] = { requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0, rawModel: r.model, provider: providerDisplayName, apiKeyMasked: null, keyName: "Local (No API Key)", apiKeyKey: r.apiKey, lastUsed: r.timestamp };
      }
      const ake = stats.byApiKey[akKey];
      ake.requests++; ake.promptTokens += promptTokens; ake.completionTokens += completionTokens; ake.cachedTokens += cachedTokens; ake.cost += entryCost;
      if (isLaterTimestamp(r.timestamp, ake.lastUsed)) ake.lastUsed = r.timestamp;
    }

    const endpoint = r.endpoint || "Unknown";
    const epKey = `${endpoint}|${r.model}|${r.provider || "unknown"}`;
    if (!stats.byEndpoint[epKey]) {
      stats.byEndpoint[epKey] = { requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0, endpoint, rawModel: r.model, provider: providerDisplayName, lastUsed: r.timestamp };
    }
    const epe = stats.byEndpoint[epKey];
    epe.requests++; epe.promptTokens += promptTokens; epe.completionTokens += completionTokens; epe.cachedTokens += cachedTokens; epe.cost += entryCost;
    if (isLaterTimestamp(r.timestamp, epe.lastUsed)) epe.lastUsed = r.timestamp;

    if (sourceIp) {
      if (!stats.bySourceIp[sourceIp]) {
        stats.bySourceIp[sourceIp] = { requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0, sourceIp, sourceGeo, lastUsed: r.timestamp };
      }
      const sie = stats.bySourceIp[sourceIp];
      sie.requests++; sie.promptTokens += promptTokens; sie.completionTokens += completionTokens; sie.cachedTokens += cachedTokens; sie.cost += entryCost;
      if (!sie.sourceGeo && sourceGeo) sie.sourceGeo = sourceGeo;
      if (isLaterTimestamp(r.timestamp, sie.lastUsed)) sie.lastUsed = r.timestamp;
    }

    if (!stats.byApp[appName]) {
      stats.byApp[appName] = { requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0, appName, lastUsed: r.timestamp };
    }
    const ape = stats.byApp[appName];
    ape.requests++; ape.promptTokens += promptTokens; ape.completionTokens += completionTokens; ape.cachedTokens += cachedTokens; ape.cost += entryCost;
    if (isLaterTimestamp(r.timestamp, ape.lastUsed)) ape.lastUsed = r.timestamp;

    const requestedAt = new Date(r.timestamp);
    const periodBucket = Math.floor(requestedAt.getHours() / 4);
    const weekdayBucket = (requestedAt.getDay() + 6) % 7;
    stats.requestRhythm.periods[periodBucket].requests++;
    stats.requestRhythm.weekdays[weekdayBucket].requests++;

    const keyInfo = r.apiKey ? apiKeyMap[r.apiKey] : null;
    const apiKeyMasked = keyInfo ? null : (r.apiKey?.startsWith("external:") ? "External API Key" : null);
    const personKey = r.apiKey || "local-no-key";
    const keyName = keyInfo?.name || (r.apiKey === "local-no-key" || !r.apiKey ? "Local (No API Key)" : r.apiKey.startsWith("external:") ? "External API Key" : "Deleted API Key");
    addPersonUsage(stats.byUser, personKey, {
      requests: 1,
      promptTokens,
      completionTokens,
      cachedTokens,
      cost: entryCost,
      timestamp: r.timestamp,
      status: r.status || "success",
      durationMs: getRequestDurationMs(r.startedAt || r.timestamp, r.completedAt || r.timestamp),
      model: r.provider ? `${r.model} (${providerDisplayName || r.provider})` : r.model,
      sourceIp,
      appName,
      periodBucket,
      weekdayBucket,
    }, { userId: personKey, keyName, apiKeyMasked });

    const startedAt = new Date(r.startedAt || r.timestamp).getTime();
    const completedAt = new Date(r.completedAt || r.timestamp).getTime();
    if (Number.isFinite(startedAt)) {
      const events = personEvents.get(personKey) || [];
      events.push({ startedAt, completedAt: Number.isFinite(completedAt) ? completedAt : startedAt });
      personEvents.set(personKey, events);
    }
  }
  finalizePersonSessionMetrics(stats.byUser, personEvents);

  const trafficTotals = getTrafficTotals(adapter, getTrafficRange(period, range));
  const trafficSummary = getTrafficSummary(adapter, { apiKeyId: range.apiKeyId || null, apiKeyIds: range.apiKeyIds || null });
  stats.totalRequestBytes = trafficTotals.requestBytes;
  stats.totalResponseBytes = trafficTotals.responseBytes;
  stats.totalTrafficBytes = trafficTotals.totalBytes;
  stats.trafficSummary = trafficSummary;
  stats.totalRequests = Object.values(stats.byProvider).reduce((sum, p) => sum + (p.requests || 0), 0);
  return stats;
}
