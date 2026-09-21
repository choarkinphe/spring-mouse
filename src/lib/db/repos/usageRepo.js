import { EventEmitter } from "events";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";
import { invalidateQuotaCache } from "@/lib/apiKeyQuotaCache.js";
import { getMeta, setMeta } from "../helpers/metaStore.js";
import { detectSourceApp } from "@/shared/utils/requestSource.js";
import { getGeoIpStatus, lookupGeoIp } from "@/lib/geoip.js";
import { enqueueUsageEvent, quotaCounterKey, updateActiveFlow, getRecentUsageEvents } from "@/lib/redis/liveUsage.js";
import { getTrafficBuckets, getTrafficSummary, getTrafficTotals } from "./trafficRepo.js";
import { runUsageAggregation } from "../usageAggregatePool.js";

function maskApiKey(key) {
  if (!key || typeof key !== "string") return null;
  if (key.length <= 8) return key.charAt(0) + "***";
  return key.slice(0, 8) + "***";
}

function getUsageKeyFingerprintSecret(db) {
  const existing = db.get(`SELECT value FROM _meta WHERE key = 'usageKeyFingerprintSecret'`);
  if (existing?.value) return existing.value;
  const secret = randomBytes(32).toString("hex");
  db.run(`INSERT INTO _meta(key, value) VALUES('usageKeyFingerprintSecret', ?) ON CONFLICT(key) DO NOTHING`, [secret]);
  return db.get(`SELECT value FROM _meta WHERE key = 'usageKeyFingerprintSecret'`)?.value || secret;
}

function externalApiKeyId(db, apiKey) {
  return `external:${createHmac("sha256", getUsageKeyFingerprintSecret(db)).update(apiKey).digest("hex").slice(0, 32)}`;
}

const PENDING_TIMEOUT_MS = 60 * 1000;
const RING_CAP = 50;
const CONN_CACHE_TTL_MS = 30 * 1000;
// The dashboard opens a REST request and an SSE connection together; both need
// the same aggregation, so share the calculation in-process.
//
// These TTLs are deliberately larger than the old 750ms/2s pair. The scan now
// runs in a worker, but it is still seconds of CPU per pass and the dashboard
// polls every ~5s (SSE full-refresh cap) — a 750ms fresh window meant almost
// every poll missed the cache and re-ran the full scan. A 5s fresh window with a
// 15s stale-while-revalidate window lets the poll actually hit the cache, while
// live in-flight state (activeRequests / recentRequests) still updates every
// event via getActiveRequests.
const STATS_CACHE_TTL_MS = 5000;
const STATS_STALE_TTL_MS = 15000;
// Even when an entry is stale, do not kick off another expensive recompute more
// often than this. Writes invalidate every period on every completed request, so
// without a floor a busy gateway would re-aggregate continuously.
const STATS_MIN_REFRESH_INTERVAL_MS = 5000;
const STATS_CACHE_MAX_ENTRIES = 50;
const PERIOD_MS = { "24h": 86400000, "7d": 604800000, "30d": 2592000000, "60d": 5184000000 };

// In-memory state shared across Next.js modules
if (!global._pendingRequests) global._pendingRequests = { byModel: {}, byAccount: {}, byFlow: {} };
if (!global._pendingRequests.byFlow) global._pendingRequests.byFlow = {};
if (!global._lastErrorProvider) global._lastErrorProvider = { provider: "", ts: 0 };
if (!global._statsEmitter) {
  global._statsEmitter = new EventEmitter();
  global._statsEmitter.setMaxListeners(50);
}
if (!global._pendingTimers) global._pendingTimers = {};
if (!global._recentRing) global._recentRing = { items: [], initialized: false };
if (!global._connectionMapCache) global._connectionMapCache = { map: {}, ts: 0 };
if (!global._apiKeyMapCache) global._apiKeyMapCache = { byKey: {}, byId: {}, ts: 0 };
if (!global._statsEmitTimers) global._statsEmitTimers = { pending: null, update: null };
if (!global._usageStatsCache) global._usageStatsCache = new Map();

const pendingRequests = global._pendingRequests;
const lastErrorProvider = global._lastErrorProvider;
const pendingTimers = global._pendingTimers;
const recentRing = global._recentRing;
const connCache = global._connectionMapCache;
const apiKeyCache = global._apiKeyMapCache;
const statsEmitTimers = global._statsEmitTimers;
const usageStatsCache = global._usageStatsCache;

function usageStatsCacheKey(period, range = {}) {
  return JSON.stringify([period, range.startDate || "", range.endDate || "", range.apiKeyId || "", range.apiKeyIds || null]);
}

function getUsageApiKeyFilter(range = {}, column = "apiKeyId") {
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

function appendUsageApiKeyFilter(conditions, params, range = {}, column = "apiKeyId") {
  const filter = getUsageApiKeyFilter(range, column);
  if (filter.clause) {
    conditions.push(filter.clause);
    params.push(...filter.params);
  }
  return filter;
}

function clearUsageStatsCache() {
  // Mark stale rather than delete: a write must not make every dashboard page
  // wait for a full re-aggregation. Each entry is refreshed in the background
  // and expires completely after STATS_STALE_TTL_MS.
  //
  // Also stamp `invalidatedAt` so getCachedUsageStats can rate-limit recomputes
  // (STATS_MIN_REFRESH_INTERVAL_MS). Every completed request invalidates every
  // period, so without that floor a busy gateway would re-scan continuously.
  const now = Date.now();
  for (const entry of usageStatsCache.values()) {
    entry.stale = true;
    entry.invalidatedAt = now;
  }
}

function trimUsageStatsCache() {
  if (usageStatsCache.size <= STATS_CACHE_MAX_ENTRIES) return;
  const oldest = [...usageStatsCache.entries()]
    .sort(([, a], [, b]) => (a.createdAt || 0) - (b.createdAt || 0))
    .slice(0, usageStatsCache.size - STATS_CACHE_MAX_ENTRIES);
  for (const [key] of oldest) usageStatsCache.delete(key);
}

export const statsEmitter = global._statsEmitter;

export function notifyUsageCommitted() {
  clearUsageStatsCache();
  scheduleStatsEvent("update", 0);
}

function scheduleStatsEvent(event, delayMs = 150) {
  const key = event === "update" ? "update" : "pending";
  if (statsEmitTimers[key]) return;
  statsEmitTimers[key] = setTimeout(() => {
    statsEmitTimers[key] = null;
    statsEmitter.emit(event);
  }, delayMs);
  statsEmitTimers[key]?.unref?.();
}

function getLocalDateKey(timestamp) {
  const d = timestamp ? new Date(timestamp) : new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
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

function getRequestDurationMs(startedAt, completedAt) {
  const start = new Date(startedAt).getTime();
  const end = new Date(completedAt).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return 0;
  return end - start;
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

function aggregateEntryToDay(day, entry) {
  const promptTokens = entry.tokens?.prompt_tokens || entry.tokens?.input_tokens || 0;
  const completionTokens = entry.tokens?.completion_tokens || entry.tokens?.output_tokens || 0;
  const cachedTokens = entry.tokens?.cached_tokens || entry.tokens?.cache_read_input_tokens || 0;
  const cost = entry.cost || 0;
  const vals = { promptTokens, completionTokens, cachedTokens, cost };

  day.requests = (day.requests || 0) + 1;
  day.promptTokens = (day.promptTokens || 0) + promptTokens;
  day.completionTokens = (day.completionTokens || 0) + completionTokens;
  day.cachedTokens = (day.cachedTokens || 0) + cachedTokens;
  day.cost = (day.cost || 0) + cost;

  day.byProvider ||= {};
  day.byModel ||= {};
  day.byAccount ||= {};
  day.byApiKey ||= {};
  day.byEndpoint ||= {};
  day.bySourceIp ||= {};
  day.byApp ||= {};
  day.byUser ||= {};

  if (entry.provider) addToCounter(day.byProvider, entry.provider, vals);

  const modelKey = entry.provider ? `${entry.model}|${entry.provider}` : entry.model;
  addToCounter(day.byModel, modelKey, { ...vals, meta: { rawModel: entry.model, provider: entry.provider } });

  if (entry.connectionId) {
    // bucket key includes model so multi-model accounts (e.g. combo accounts) keep
    // per-model token splits in 7d/30d/60d/all views. Reading code in
    // useDailySummary() expects a.rawModel/a.provider on each bucket.
    const accountBucketKey = `${entry.connectionId}|${entry.model}|${entry.provider || "unknown"}`;
    addToCounter(day.byAccount, accountBucketKey, { ...vals, meta: { connectionId: entry.connectionId, rawModel: entry.model, provider: entry.provider } });
  }

  const apiKeyVal = entry.apiKey && typeof entry.apiKey === "string" ? entry.apiKey : "local-no-key";
  const akModelKey = `${apiKeyVal}|${entry.model}|${entry.provider || "unknown"}`;
  addToCounter(day.byApiKey, akModelKey, { ...vals, meta: { rawModel: entry.model, provider: entry.provider, apiKey: entry.apiKey || null } });

  const endpoint = entry.endpoint || "Unknown";
  const epKey = `${endpoint}|${entry.model}|${entry.provider || "unknown"}`;
  addToCounter(day.byEndpoint, epKey, { ...vals, meta: { endpoint, rawModel: entry.model, provider: entry.provider } });

  if (entry.sourceIp) {
    addToCounter(day.bySourceIp, entry.sourceIp, {
      ...vals,
      meta: { sourceIp: entry.sourceIp, sourceGeo: entry.sourceGeo || null },
    });
  }

  const appName = detectSourceApp(entry);
  addToCounter(day.byApp, appName, { ...vals, meta: { appName } });

  const requestedAt = new Date(entry.timestamp);
  const userKey = apiKeyVal;
  addPersonUsage(day.byUser, userKey, {
    ...vals,
    timestamp: entry.timestamp,
    status: entry.status || "success",
    durationMs: getRequestDurationMs(entry.startedAt || entry.timestamp, entry.completedAt || entry.timestamp),
    model: entry.model || "unknown",
    sourceIp: entry.sourceIp || null,
    appName,
    periodBucket: Number.isNaN(requestedAt.getTime()) ? null : Math.floor(requestedAt.getHours() / 4),
    weekdayBucket: Number.isNaN(requestedAt.getTime()) ? null : (requestedAt.getDay() + 6) % 7,
  }, { apiKey: entry.apiKey || null });
}

function pushToRing(entry) {
  recentRing.items.push(entry);
  if (recentRing.items.length > RING_CAP) {
    recentRing.items = recentRing.items.slice(-RING_CAP);
  }
}

function toRecentRequest(entry, apiKeyMaps) {
  const t = entry.tokens || {};
  const apiKeyId = entry.apiKeyId || entry.apiKey || "local-no-key";
  return {
    requestId: entry.requestId || null,
    timestamp: entry.timestamp,
    model: entry.model,
    provider: entry.provider || "",
    apiKeyId,
    userName: getUsageUserName(apiKeyId, apiKeyMaps.byId),
    promptTokens: Number(entry.promptTokens ?? t.prompt_tokens ?? t.input_tokens) || 0,
    completionTokens: Number(entry.completionTokens ?? t.completion_tokens ?? t.output_tokens) || 0,
    status: entry.status || "ok",
    tokensEstimated: t.estimated === true,
  };
}

async function getConnectionMapCached() {
  if (Date.now() - connCache.ts < CONN_CACHE_TTL_MS) return connCache.map;
  try {
    const { getProviderConnections } = await import("./connectionsRepo.js");
    const all = await getProviderConnections();
    const map = {};
    for (const c of all) map[c.id] = c.name || c.email || c.id;
    connCache.map = map;
    connCache.ts = Date.now();
  } catch {}
  return connCache.map;
}

async function getApiKeyMapCached() {
  if (Date.now() - apiKeyCache.ts < CONN_CACHE_TTL_MS && apiKeyCache.byKey && apiKeyCache.byId) return apiKeyCache;
  try {
    const db = await getAdapter();
    const byKey = {};
    const byId = {};
    for (const row of db.all(`SELECT id, key, name FROM apiKeys`)) {
      const keyInfo = { id: row.id, name: row.name || "API Key" };
      byKey[row.key] = keyInfo;
      byId[row.id] = keyInfo;
    }
    apiKeyCache.byKey = byKey;
    apiKeyCache.byId = byId;
    apiKeyCache.ts = Date.now();
  } catch {}
  return apiKeyCache;
}

function getUsageUserName(apiKeyId, apiKeyMap = {}) {
  if (apiKeyMap[apiKeyId]?.name) return apiKeyMap[apiKeyId].name;
  if (apiKeyId === "local-no-key" || !apiKeyId) return "本地（未带 Key）";
  if (typeof apiKeyId === "string" && apiKeyId.startsWith("external:")) return "外部 API Key";
  return "已删除 API Key";
}

async function ensureRingInitialized() {
  if (recentRing.initialized) return;
  recentRing.initialized = true;
  try {
    const db = await getAdapter();
    const rows = db.all(`SELECT timestamp, provider, model, connectionId, apiKeyId AS apiKey, endpoint, cost, status, tokens FROM usageHistory ORDER BY id DESC LIMIT ?`, [RING_CAP]);
    recentRing.items = rows.reverse().map((r) => ({
      timestamp: r.timestamp, provider: r.provider, model: r.model, connectionId: r.connectionId,
      apiKey: r.apiKey, endpoint: r.endpoint, cost: r.cost, status: r.status,
      tokens: parseJson(r.tokens, {}),
    }));
  } catch {}
}

async function calculateCost(provider, model, tokens) {
  if (!tokens || !provider || !model) return 0;
  try {
    const { getPricingForModel } = await import("./pricingRepo.js");
    const pricing = await getPricingForModel(provider, model);
    if (!pricing) return 0;

    // Delegate the actual math to the single source of truth (avoids the two
    // copies drifting apart — see open-sse/providers/pricing.js for the
    // cache-inclusive prompt_tokens convention this assumes).
    const { calculateCostFromTokens } = await import("open-sse/providers/pricing.js");
    return calculateCostFromTokens(tokens, pricing);
  } catch (e) {
    console.error("Error calculating cost:", e);
    return 0;
  }
}

function updatePendingAggregate(modelKey, connectionId, delta) {
  const nextModelCount = Math.max(0, (pendingRequests.byModel[modelKey] || 0) + delta);
  if (nextModelCount === 0) delete pendingRequests.byModel[modelKey];
  else pendingRequests.byModel[modelKey] = nextModelCount;

  if (!connectionId) return;
  const account = pendingRequests.byAccount[connectionId] || {};
  const nextAccountCount = Math.max(0, (account[modelKey] || 0) + delta);
  if (nextAccountCount === 0) delete account[modelKey];
  else account[modelKey] = nextAccountCount;

  if (Object.keys(account).length === 0) delete pendingRequests.byAccount[connectionId];
  else pendingRequests.byAccount[connectionId] = account;
}

function getPendingFlowKey(model, provider, connectionId, apiKey) {
  const modelKey = provider ? `${model} (${provider})` : model;
  return {
    modelKey,
    flowKey: JSON.stringify([connectionId || "", modelKey, apiKey || ""]),
  };
}

function finiteTokenCount(value) {
  if (value == null) return null;
  const tokenCount = Number(value);
  return Number.isFinite(tokenCount) ? Math.max(0, Math.round(tokenCount)) : null;
}

// Per-request counters avoid one stream overwriting another on the same route.
// These are dashboard telemetry only; billing continues to use final usage.
export function updatePendingRequestTokens(model, provider, connectionId, apiKey, requestId, tokens = {}) {
  const { flowKey } = getPendingFlowKey(model, provider, connectionId, apiKey);
  const flow = pendingRequests.byFlow[flowKey];
  const progress = flow?.requests?.[requestId];
  if (!progress) return;

  for (const field of ["inputTokens", "outputTokens"]) {
    const value = finiteTokenCount(tokens[field]);
    if (value !== null) progress[field] = value;
  }
  progress.estimated = tokens.estimated !== false;
  pendingTimers[flowKey]?.refresh?.();
  // Share the existing coalesced live SSE patch, never trigger aggregate scans.
  scheduleStatsEvent("pending", 250);
}

function getFlowTokens(flow) {
  const values = Object.values(flow.requests || {});
  return {
    inputTokens: values.reduce((total, item) => total + item.inputTokens, 0),
    outputTokens: values.reduce((total, item) => total + item.outputTokens, 0),
    tokensEstimated: !values.length || values.some((item) => item.estimated),
  };
}

export function trackPendingRequest(model, provider, connectionId, started, error = false, apiKey = null, requestId = null) {
  const { modelKey, flowKey } = getPendingFlowKey(model, provider, connectionId, apiKey);
  // A flow identifies one caller → provider account route. Keep the raw API key
  // only in process memory until the request completes; the dashboard receives
  // the resolved key name or a masked fallback, never the credential itself.
  const redisFlowId = createHash("sha256").update(flowKey).digest("hex").slice(0, 32);
  const existingFlow = pendingRequests.byFlow[flowKey];

  if (started) {
    if (requestId && existingFlow?.requests?.[requestId]) return;
    updatePendingAggregate(modelKey, connectionId, 1);
    const flow = existingFlow || {
      model,
      provider: provider || "unknown",
      connectionId: connectionId || "",
      apiKey,
      count: 0,
      requests: {},
    };
    if (requestId) {
      flow.requests ||= {};
      if (flow.requests[requestId]) return;
      flow.requests[requestId] = { inputTokens: 0, outputTokens: 0, estimated: true };
    }
    flow.count += 1;
    pendingRequests.byFlow[flowKey] = flow;

    clearTimeout(pendingTimers[flowKey]);
    pendingTimers[flowKey] = setTimeout(() => {
      delete pendingTimers[flowKey];
      const staleFlow = pendingRequests.byFlow[flowKey];
      if (staleFlow) {
        // Fail open for a stalled upstream request: remove only this exact route
        // rather than hiding other callers that happen to use the same model.
        updatePendingAggregate(modelKey, connectionId, -staleFlow.count);
        updateActiveFlow(redisFlowId, staleFlow, -staleFlow.count).catch(() => {});
        delete pendingRequests.byFlow[flowKey];
      }
      scheduleStatsEvent("pending");
    }, PENDING_TIMEOUT_MS);
    updateActiveFlow(redisFlowId, flow, 1).catch(() => {});
  } else if (existingFlow) {
    // Completion and disconnect may both fire. Remove only this request once.
    if (requestId && !existingFlow.requests?.[requestId]) return;
    if (requestId) delete existingFlow.requests[requestId];
    updatePendingAggregate(modelKey, connectionId, -1);
    existingFlow.count = Math.max(0, existingFlow.count - 1);
    updateActiveFlow(redisFlowId, existingFlow, -1).catch(() => {});
    if (existingFlow.count === 0) {
      clearTimeout(pendingTimers[flowKey]);
      delete pendingTimers[flowKey];
      delete pendingRequests.byFlow[flowKey];
    }
  }

  if (!started && error && provider) {
    lastErrorProvider.provider = provider.toLowerCase();
    lastErrorProvider.ts = Date.now();
  }

  // [PENDING] console line removed; lifecycle is visible via "▶" and "📊 done" lines
  scheduleStatsEvent("pending");
}

export async function getActiveRequests(apiKeyId = null) {
  const activeRequests = [];
  const scopedApiKeyIds = Array.isArray(apiKeyId) ? new Set(apiKeyId) : null;
  const [connectionMap, apiKeyMaps] = await Promise.all([getConnectionMapCached(), getApiKeyMapCached()]);

  for (const flow of Object.values(pendingRequests.byFlow || {})) {
    if (!flow?.count) continue;
    const client = flow.apiKey ? apiKeyMaps.byKey?.[flow.apiKey] : null;
    if (scopedApiKeyIds ? !scopedApiKeyIds.has(client?.id) : apiKeyId && client?.id !== apiKeyId) continue;
    const accountName = flow.connectionId
      ? connectionMap[flow.connectionId] || `Account ${flow.connectionId.slice(0, 8)}...`
      : "Unassigned account";

    activeRequests.push({
      model: flow.model,
      provider: flow.provider || "unknown",
      account: accountName,
      count: flow.count,
      ...getFlowTokens(flow),
      apiKey: {
        id: client?.id || (flow.apiKey ? "external" : "local"),
        name: client?.name || (flow.apiKey ? `API Key ${maskApiKey(flow.apiKey)}` : "Local client"),
      },
    });
  }

  await ensureRingInitialized();
  const redisRecent = await getRecentUsageEvents(50).catch(() => null);
  const recentEntries = redisRecent
    ? [...recentRing.items, ...redisRecent]
    : recentRing.items;
  const seen = new Set();
  const recentRequests = recentEntries
    .filter((e) => {
      if (scopedApiKeyIds) return scopedApiKeyIds.has(e.apiKeyId || apiKeyMaps.byKey?.[e.apiKey]?.id);
      return !apiKeyId || (e.apiKeyId || e.apiKey) === apiKeyId || apiKeyMaps.byKey?.[e.apiKey]?.id === apiKeyId;
    })
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
    .map((e) => toRecentRequest(e, apiKeyMaps))
    .filter((e) => {
      if (e.promptTokens === 0 && e.completionTokens === 0) return false;
      const key = e.requestId || `${e.apiKeyId}|${e.model}|${e.provider}|${e.promptTokens}|${e.completionTokens}|${e.timestamp}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 50);

  const errorProvider = (Date.now() - lastErrorProvider.ts < 10000) ? lastErrorProvider.provider : "";
  return { activeRequests, recentRequests, errorProvider };
}

function persistUsageRecord(db, record, knownKeyId, promptTokens, completionTokens) {
  let inserted = false;
  db.transaction(() => {
    const existing = db.get(`SELECT id FROM usageHistory WHERE requestId = ?`, [record.requestId]);
    if (existing) return;

    const insertResult = db.run(
      `INSERT OR IGNORE INTO usageHistory(timestamp, provider, model, connectionId, apiKey, apiKeyId, requestId, trafficRequestId, startedAt, completedAt, endpoint, promptTokens, completionTokens, cost, status, tokens, meta) VALUES(?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        record.timestamp, record.provider || null, record.model || null,
        record.connectionId || null, record.apiKeyId, record.requestId, record.trafficRequestId || null, record.startedAt, record.completedAt, record.endpoint || null,
        promptTokens, completionTokens, record.cost || 0, record.status || "success", stringifyJson(record.tokens || {}), stringifyJson(record.meta || {}),
      ],
    );
    if ((insertResult?.changes ?? 1) === 0) return;

    if (knownKeyId) {
      db.run(
        `UPDATE apiKeys
            SET lastUsedAt = CASE
              WHEN lastUsedAt IS NULL OR lastUsedAt < ? THEN ?
              ELSE lastUsedAt
            END
          WHERE id = ?`,
        [record.completedAt, record.completedAt, knownKeyId],
      );
    }

    const cur = db.get(`SELECT value FROM _meta WHERE key = 'totalRequestsLifetime'`);
    const next = (cur ? parseInt(cur.value, 10) : 0) + 1;
    db.run(`INSERT INTO _meta(key, value) VALUES('totalRequestsLifetime', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [String(next)]);
    inserted = true;
  });
  return inserted;
}

export async function saveRequestUsage(entry) {
  try {
    const db = await getAdapter();
    const completedAt = entry.completedAt || new Date().toISOString();
    const startedAt = entry.startedAt || entry.timestamp || completedAt;
    const requestId = entry.requestId || randomUUID();
    if (db.get(`SELECT id FROM usageHistory WHERE requestId = ?`, [requestId])) return;
    const rawApiKey = typeof entry.apiKey === "string" ? entry.apiKey : null;
    const knownKey = entry.apiKeyId
      ? db.get(`SELECT id, key, fiveHourQuotaResetAt, weeklyQuotaResetAt FROM apiKeys WHERE id = ?`, [entry.apiKeyId]) || { id: entry.apiKeyId }
      : rawApiKey
        ? db.get(`SELECT id, key, fiveHourQuotaResetAt, weeklyQuotaResetAt FROM apiKeys WHERE key = ?`, [rawApiKey])
        : null;
    const apiKeyId = knownKey?.id
      || (rawApiKey ? externalApiKeyId(db, rawApiKey) : "local-no-key");
    const record = {
      ...entry,
      requestId,
      timestamp: startedAt,
      startedAt,
      completedAt,
      apiKey: apiKeyId,
      apiKeyId,
    };

    record.cost = await calculateCost(record.provider, record.model, record.tokens);
    record.sourceGeo = await lookupGeoIp(record.sourceIp);

    const tokens = record.tokens || {};
    const promptTokens = tokens.prompt_tokens || tokens.input_tokens || 0;
    const completionTokens = tokens.completion_tokens || tokens.output_tokens || 0;
    const status = record.status || "success";
    const usageEvent = {
      requestId: record.requestId,
      trafficRequestId: record.trafficRequestId || null,
      timestamp: record.timestamp,
      startedAt: record.startedAt,
      completedAt: record.completedAt,
      provider: record.provider || null,
      model: record.model || null,
      connectionId: record.connectionId || null,
      apiKeyId: record.apiKeyId,
      knownApiKeyId: knownKey?.id || null,
      endpoint: record.endpoint || null,
      promptTokens,
      completionTokens,
      cost: record.cost || 0,
      status,
      tokens,
      meta: {
        sourceIp: record.sourceIp || null,
        sourceGeo: record.sourceGeo || null,
        appName: record.appName || null,
        userAgent: record.userAgent || null,
        sourceUrl: record.sourceUrl || null,
      },
    };

    const usageAffectsQuota = ["success", "ok"].includes(status) && promptTokens + completionTokens > 0;
    const quotaCounters = usageAffectsQuota && knownKey?.id
      ? [
        knownKey.fiveHourQuotaResetAt && { key: quotaCounterKey(knownKey.id, "fiveHour", knownKey.fiveHourQuotaResetAt), delta: promptTokens + completionTokens },
        knownKey.weeklyQuotaResetAt && { key: quotaCounterKey(knownKey.id, "weekly", knownKey.weeklyQuotaResetAt), delta: promptTokens + completionTokens },
      ].filter(Boolean)
      : [];

    let queued = false;
    try {
      queued = await enqueueUsageEvent(usageEvent, quotaCounters);
    } catch (error) {
      console.error("[UsageQueue] enqueue failed, falling back to SQLite:", error.message);
    }

    const inserted = queued || persistUsageRecord(db, usageEvent, knownKey?.id || null, promptTokens, completionTokens);
    if (inserted) {
      const quotaCacheKey = rawApiKey || knownKey?.key;
      if (quotaCacheKey && usageAffectsQuota) invalidateQuotaCache(quotaCacheKey);
      // Keep the local recent-request overlay and SSE event immediate. The
      // durable aggregate refresh follows the writer commit notification.
      clearUsageStatsCache();
      pushToRing(record);
      scheduleStatsEvent("update", 250);
    }
  } catch (e) {
    console.error("Failed to save usage stats:", e);
  }
}

export async function getUsageHistory(filter = {}) {
  const db = await getAdapter();
  const conds = [];
  const params = [];

  if (filter.provider) { conds.push("provider = ?"); params.push(filter.provider); }
  if (filter.model) { conds.push("model = ?"); params.push(filter.model); }
  if (filter.startDate) { conds.push("timestamp >= ?"); params.push(new Date(filter.startDate).toISOString()); }
  if (filter.endDate) { conds.push("timestamp <= ?"); params.push(new Date(filter.endDate).toISOString()); }

  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
  const rows = db.all(`SELECT timestamp, provider, model, connectionId, apiKeyId AS apiKey, endpoint, cost, status, tokens FROM usageHistory ${where} ORDER BY id ASC`, params);

  return rows.map((r) => ({
    timestamp: r.timestamp, provider: r.provider, model: r.model,
    connectionId: r.connectionId, apiKeyId: r.apiKey, endpoint: r.endpoint,
    cost: r.cost, status: r.status, tokens: parseJson(r.tokens, {}),
  }));
}

// Dashboard channel list enrichment: the most recent request time per provider
// connection. Every relayed attempt writes usageHistory with its connectionId,
// so this reflects "is the account actually serving traffic" independently of
// whether the last attempt failed.
export async function getConnectionLastRequestAt(connectionIds = []) {
  const ids = Array.from(new Set((connectionIds || []).filter((id) => typeof id === "string" && id)));
  if (ids.length === 0) return {};

  const db = await getAdapter();
  const result = {};
  // Keep the IN list small enough to stay under SQLite's variable limit.
  const CHUNK_SIZE = 400;
  for (let start = 0; start < ids.length; start += CHUNK_SIZE) {
    const chunk = ids.slice(start, start + CHUNK_SIZE);
    const rows = db.all(
      `SELECT connectionId, MAX(timestamp) AS lastRequestAt FROM usageHistory WHERE connectionId IN (${chunk.map(() => "?").join(", ")}) GROUP BY connectionId`,
      chunk,
    );
    for (const row of rows) {
      if (row?.connectionId && row.lastRequestAt) result[row.connectionId] = row.lastRequestAt;
    }
  }
  return result;
}


export async function getUsageDetails(filter = {}) {
  const db = await getAdapter();
  const conds = [];
  const params = [];

  if (filter.provider) { conds.push("provider = ?"); params.push(filter.provider); }
  if (filter.model) { conds.push("model = ?"); params.push(filter.model); }
  if (filter.connectionId) { conds.push("connectionId = ?"); params.push(filter.connectionId); }
  if (filter.status) { conds.push("status = ?"); params.push(filter.status); }
  appendUsageApiKeyFilter(conds, params, filter);
  if (filter.apiKeyId === "local-no-key") {
    conds.push("apiKeyId IS NULL");
  } else if (filter.apiKeyId) {
    conds.push("apiKeyId = ?");
    params.push(filter.apiKeyId);
  }
  if (filter.startDate) { conds.push("timestamp >= ?"); params.push(new Date(filter.startDate).toISOString()); }
  if (filter.endDate) { conds.push("timestamp <= ?"); params.push(new Date(filter.endDate).toISOString()); }
  if (filter.sourceIp) {
    conds.push("json_extract(CASE WHEN json_valid(meta) THEN meta ELSE '{}' END, '$.sourceIp') = ?");
    params.push(filter.sourceIp);
  }

  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
  const page = Math.max(1, Number(filter.page) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(filter.pageSize) || 20));
  const offset = (page - 1) * pageSize;

  // sourceIp is stored in the JSON metadata column. Keep that filter in SQL so
  // rare/old IPs are not discarded by LIMIT before the metadata is inspected.
  // appName still needs detectSourceApp(), so resolve matching IDs first and
  // paginate that filtered ID list instead of filtering only the current page.
  const countResult = db.get(`SELECT COUNT(*) as total FROM usageHistory ${where}`, params);
  const unfilteredTotalItems = countResult?.total || 0;
  let totalItems = unfilteredTotalItems;
  let rows;
  const selectDetails = `SELECT id, timestamp, startedAt, completedAt, provider, model, connectionId, apiKeyId, endpoint, promptTokens, completionTokens, cost, status, tokens, meta, trafficRequestId,
            COALESCE((SELECT requestBytes FROM networkTraffic nt WHERE nt.requestId = usageHistory.trafficRequestId), 0) AS requestBytes,
            COALESCE((SELECT responseBytes FROM networkTraffic nt WHERE nt.requestId = usageHistory.trafficRequestId), 0) AS responseBytes
       FROM usageHistory`;

  if (filter.appName) {
    const matchingIds = db.all(`SELECT id, meta FROM usageHistory ${where} ORDER BY id DESC`, params)
      .filter((row) => detectSourceApp(parseJson(row.meta, {}) || {}) === filter.appName)
      .map((row) => row.id);
    totalItems = matchingIds.length;
    const pageIds = matchingIds.slice(offset, offset + pageSize);
    rows = pageIds.length
      ? db.all(`${selectDetails} WHERE id IN (${pageIds.map(() => "?").join(", ")}) ORDER BY id DESC`, pageIds)
      : [];
  } else {
    rows = db.all(`${selectDetails} ${where} ORDER BY id DESC LIMIT ? OFFSET ?`, [...params, pageSize, offset]);
  }
  const totalPages = Math.ceil(totalItems / pageSize);
  const apiKeyMaps = await getApiKeyMapCached();

  const details = rows
    .map((row) => {
      const tokens = parseJson(row.tokens, {}) || {};
      const meta = parseJson(row.meta, {}) || {};
      const promptTokens = row.promptTokens ?? tokens.prompt_tokens ?? tokens.input_tokens ?? 0;
      const completionTokens = row.completionTokens ?? tokens.completion_tokens ?? tokens.output_tokens ?? 0;
      const apiKeyId = row.apiKeyId || "local-no-key";
      return {
        id: row.id,
        timestamp: row.timestamp,
        provider: row.provider || "unknown",
        model: row.model || "unknown",
        connectionId: row.connectionId || null,
        apiKeyId,
        keyName: getUsageUserName(apiKeyId, apiKeyMaps.byId),
        appName: detectSourceApp(meta),
        sourceIp: meta.sourceIp || null,
        endpoint: row.endpoint || "Unknown",
        status: row.status || "success",
        promptTokens,
        completionTokens,
        cachedTokens: tokens.cached_tokens ?? tokens.cache_read_input_tokens ?? 0,
        totalTokens: promptTokens + completionTokens,
        cost: row.cost || 0,
        durationMs: getRequestDurationMs(row.startedAt || row.timestamp, row.completedAt || row.timestamp),
        requestBytes: Number(row.requestBytes) || 0,
        responseBytes: Number(row.responseBytes) || 0,
        totalBytes: (Number(row.requestBytes) || 0) + (Number(row.responseBytes) || 0),
      };
    });

  return {
    details,
    pagination: {
      page,
      pageSize,
      totalItems,
      totalPages,
      hasNext: page < totalPages,
      hasPrev: page > 1,
    },
    // appName is derived from metadata; expose the candidate count before that
    // derived filter for diagnostics while keeping normal SQL filters included.
    unfilteredPagination: {
      totalItems: unfilteredTotalItems,
      totalPages: Math.ceil(unfilteredTotalItems / pageSize),
    },
  };
}


function getRecentCallDetails(db, period, range, apiKeyMap, providerNodeNameMap) {
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
  const rows = db.all(
    `SELECT id, timestamp, startedAt, completedAt, provider, model, apiKeyId AS apiKey, endpoint, promptTokens, completionTokens, cost, status, tokens, meta, trafficRequestId,
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

function getTrafficRange(period, range = {}) {
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

/**
 * Aggregation dispatcher.
 *
 * The scan itself is heavy (up to ~500k rows, seconds of synchronous SQLite
 * work). It runs in a worker thread via `runUsageAggregation` so the Node event
 * loop stays free — a blocked loop prevents undici's connect-timeout timers
 * from firing and turns into mass upstream timeouts. When the worker is
 * unavailable the pool falls back to running the same core in-process, which is
 * correct but blocking.
 *
 * The shared implementation lives in `runtime/usage-aggregate.mjs` so the
 * worker and the fallback cannot drift apart.
 */
async function calculateUsageStats(period = "all", range = {}) {
  const db = await getAdapter();

  const [{ getProviderConnections }, { getApiKeys }, { getProviderNodes }] = await Promise.all([
    import("./connectionsRepo.js"),
    import("./apiKeysRepo.js"),
    import("./nodesRepo.js"),
  ]);

  // These are small control-plane tables. Reading them here (rather than in the
  // worker) keeps the worker dependency-free and its payload tiny.
  let allConnections = [];
  try { allConnections = await getProviderConnections(); } catch {}
  const connectionMap = {};
  for (const c of allConnections) connectionMap[c.id] = c.name || c.email || c.id;

  const providerNodeNameMap = {};
  try {
    const nodes = await getProviderNodes();
    for (const n of nodes) if (n.id && n.name) providerNodeNameMap[n.id] = n.name;
  } catch {}

  let allApiKeys = [];
  try { allApiKeys = await getApiKeys(); } catch {}
  const apiKeyMap = {};
  for (const k of allApiKeys) apiKeyMap[k.id] = { name: k.name, id: k.id, createdAt: k.createdAt };

  const sourceCapture = {
    ipEnabled: Boolean(process.env.SPRING_MOUSE_PEER_TOKEN) || process.env.NODE_ENV !== "production",
    mode: process.env.SPRING_MOUSE_PEER_TOKEN ? "trusted" : process.env.NODE_ENV !== "production" ? "development" : "disabled",
    appEnabled: true,
    geoip: getGeoIpStatus(),
  };

  const stats = await runUsageAggregation({
    adapter: db,
    params: { period, range, connectionMap, apiKeyMap, providerNodeNameMap, sourceCapture, now: new Date() },
  });

  // Live, in-process state is overlaid here: it is not in the DB, so the worker
  // cannot produce it.
  stats.pending = pendingRequests;
  stats.activeRequests = [];
  if (!range.apiKeyId && !Array.isArray(range.apiKeyIds)) {
    for (const [connectionId, models] of Object.entries(pendingRequests.byAccount)) {
      for (const [modelKey, count] of Object.entries(models)) {
        if (count > 0) {
          const accountName = connectionMap[connectionId] || `Account ${connectionId.slice(0, 8)}...`;
          const match = modelKey.match(/^(.*) \((.*)\)$/);
          stats.activeRequests.push({
            model: match ? match[1] : modelKey,
            provider: match ? match[2] : "unknown",
            account: accountName, count,
          });
        }
      }
    }
  }
  stats.errorProvider = (Date.now() - lastErrorProvider.ts < 10000) ? lastErrorProvider.provider : "";

  return stats;
}


/**
 * Share dashboard aggregations between the REST loader and its SSE stream.
 * Fresh entries are returned immediately. When a completed request invalidates
 * an entry, retain its last value for at most two seconds and refresh in the
 * background; the follow-up SSE event carries the exact new aggregate.
 */
export async function getUsageStats(period = "all", range = {}) {
  const stats = await getCachedUsageStats(period, range);
  const live = await getActiveRequests(Array.isArray(range.apiKeyIds) ? range.apiKeyIds : range.apiKeyId);
  return { ...stats, ...live };
}

async function getCachedUsageStats(period = "all", range = {}) {
  const key = usageStatsCacheKey(period, range);
  const now = Date.now();
  const cached = usageStatsCache.get(key);

  if (cached && !cached.stale && now - cached.createdAt < STATS_CACHE_TTL_MS) {
    return cached.promise;
  }

  const canServeStale = cached && now - cached.createdAt < STATS_STALE_TTL_MS;
  if (canServeStale) {
    // Rate-limit the background recompute. Every completed request invalidates
    // every period, so on a busy gateway a stale entry can be re-invalidated
    // faster than the scan completes. Serving the last value until the floor
    // elapses keeps the worker from being pinned at 100% CPU.
    const sinceInvalidated = cached.invalidatedAt ? now - cached.invalidatedAt : Infinity;
    const tooSoon = sinceInvalidated < STATS_MIN_REFRESH_INTERVAL_MS;
    if (!cached.refreshPromise && !tooSoon) {
      const refreshPromise = calculateUsageStats(period, range)
        .then((stats) => {
          const current = usageStatsCache.get(key);
          if (current?.refreshPromise !== refreshPromise) return stats;
          usageStatsCache.set(key, {
            createdAt: Date.now(),
            promise: Promise.resolve(stats),
            stale: false,
            refreshPromise: null,
            invalidatedAt: 0,
          });
          // The page that received a fast stale snapshot gets the exact update
          // through its already-open SSE connection.
          scheduleStatsEvent("update", 0);
          return stats;
        })
        .catch(() => {
          const current = usageStatsCache.get(key);
          if (current?.refreshPromise === refreshPromise) current.refreshPromise = null;
        });
      cached.refreshPromise = refreshPromise;
    }
    return cached.promise;
  }

  const promise = calculateUsageStats(period, range)
    .catch((error) => {
      const current = usageStatsCache.get(key);
      if (current?.promise === promise) usageStatsCache.delete(key);
      throw error;
    });
  usageStatsCache.set(key, { createdAt: now, promise, stale: false, refreshPromise: null, invalidatedAt: 0 });
  trimUsageStatsCache();
  return promise;
}

function getChartBuckets(db, { startTime, endTime, bucketMs, bucketCount, apiKeyFilter, apiKeyIds, labelFn }) {
  const startIso = new Date(startTime).toISOString();
  const endIso = new Date(endTime).toISOString();
  const scopeFilter = getUsageApiKeyFilter({ apiKeyId: apiKeyFilter, apiKeyIds });
  const rows = db.all(
    `SELECT
      CAST(((julianday(timestamp) - julianday(?)) * 86400000.0) / ? AS INTEGER) AS bucketIndex,
      SUM(promptTokens + completionTokens) AS tokens,
      SUM(cost) AS cost,
      COUNT(*) AS requests
    FROM usageHistory
    WHERE timestamp >= ? AND timestamp <= ?${scopeFilter.clause ? ` AND ${scopeFilter.clause}` : ""}
    GROUP BY bucketIndex
    ORDER BY bucketIndex`,
    [startIso, bucketMs, startIso, endIso, ...scopeFilter.params],
  );

  const buckets = Array.from({ length: bucketCount }, (_, index) => ({
    label: labelFn(startTime + index * bucketMs),
    tokens: 0,
    cost: 0,
    requests: 0,
  }));
  for (const row of rows) {
    const index = Number(row.bucketIndex);
    if (index >= 0 && index < bucketCount) {
      buckets[index] = {
        label: labelFn(startTime + index * bucketMs),
        tokens: Number(row.tokens) || 0,
        cost: Number(row.cost) || 0,
        requests: Number(row.requests) || 0,
      };
    }
  }
  return buckets;
}

async function addTrafficToChartBuckets(buckets, options) {
  const trafficBuckets = await getTrafficBuckets(options);
  return buckets.map((bucket, index) => ({ ...bucket, ...(trafficBuckets[index] || { requestBytes: 0, responseBytes: 0, trafficBytes: 0 }) }));
}

export async function getChartData(period = "7d", range = {}) {
  const db = await getAdapter();
  const now = Date.now();
  const apiKeyFilter = range.apiKeyId || null;
  const apiKeyIds = range.apiKeyIds || null;

  if (range.startDate && range.endDate) {
    const startTime = new Date(range.startDate).getTime();
    const endTime = new Date(range.endDate).getTime();
    const durationMs = Math.max(endTime - startTime, 1);
    const useHourlyBuckets = durationMs <= 48 * 3600000;
    const bucketMs = useHourlyBuckets ? 3600000 : 86400000;
    const bucketCount = Math.min(Math.ceil(durationMs / bucketMs), useHourlyBuckets ? 48 : 90);
    const labelFn = useHourlyBuckets
      ? (timestamp) => new Date(timestamp).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false })
      : (timestamp) => new Date(timestamp).toLocaleDateString("en-US", { month: "short", day: "numeric" });

    return addTrafficToChartBuckets(getChartBuckets(db, { startTime, endTime, bucketMs, bucketCount, apiKeyFilter, apiKeyIds, labelFn }), { startTime, endTime, bucketMs, bucketCount, apiKeyId: apiKeyFilter, apiKeyIds });
  }

  if (period === "today") {
    const bucketCount = 24;
    const bucketMs = 3600000;
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const startTime = startOfDay.getTime();
    const labelFn = (timestamp) => new Date(timestamp).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });

    const endTime = startTime + bucketCount * bucketMs - 1;
    return addTrafficToChartBuckets(getChartBuckets(db, {
      startTime,
      endTime,
      bucketMs,
      bucketCount,
      apiKeyFilter,
      apiKeyIds,
      labelFn,
    }), { startTime, endTime, bucketMs, bucketCount, apiKeyId: apiKeyFilter, apiKeyIds });
  }

  if (period === "24h") {
    const bucketCount = 24;
    const bucketMs = 3600000;
    const startTime = now - bucketCount * bucketMs;
    const labelFn = (timestamp) => new Date(timestamp).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });

    return addTrafficToChartBuckets(getChartBuckets(db, { startTime, endTime: now, bucketMs, bucketCount, apiKeyFilter, apiKeyIds, labelFn }), { startTime, endTime: now, bucketMs, bucketCount, apiKeyId: apiKeyFilter, apiKeyIds });
  }

  const bucketCount = period === "7d" ? 7 : period === "30d" ? 30 : 60;
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - (bucketCount - 1));
  const startTime = start.getTime();
  const bucketMs = 86400000;
  const labelFn = (timestamp) => new Date(timestamp).toLocaleDateString("en-US", { month: "short", day: "numeric" });

  const endTime = startTime + bucketCount * bucketMs - 1;
  return addTrafficToChartBuckets(getChartBuckets(db, {
    startTime,
    endTime,
    bucketMs,
    bucketCount,
    apiKeyFilter,
    apiKeyIds,
    labelFn,
  }), { startTime, endTime, bucketMs, bucketCount, apiKeyId: apiKeyFilter, apiKeyIds });
}

function formatLogDate(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(date.getDate())}-${pad(date.getMonth() + 1)}-${date.getFullYear()} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

// No-op: request log is now derived from usageHistory table on read.
export async function appendRequestLog() {}

export async function getRecentLogs(limit = 200) {
  try {
    const db = await getAdapter();
    const rows = db.all(
      `SELECT timestamp, provider, model, connectionId, promptTokens, completionTokens, status, tokens FROM usageHistory ORDER BY id DESC LIMIT ?`,
      [limit],
    );
    if (!rows.length) return [];

    const connMap = {};
    try {
      const { getProviderConnections } = await import("./connectionsRepo.js");
      const connections = await getProviderConnections();
      for (const c of connections) connMap[c.id] = c.name || c.email || "";
    } catch {}

    return rows.map((r) => {
      const ts = formatLogDate(new Date(r.timestamp));
      const p = r.provider?.toUpperCase() || "-";
      const m = r.model || "-";
      const account = connMap[r.connectionId] || (r.connectionId ? r.connectionId.slice(0, 8) : "-");
      const tk = r.tokens ? parseJson(r.tokens, {}) : {};
      const sent = r.promptTokens ?? tk.prompt_tokens ?? "-";
      const received = r.completionTokens ?? tk.completion_tokens ?? "-";
      return `${ts} | ${m} | ${p} | ${account} | ${sent} | ${received} | ${r.status || "-"}`;
    });
  } catch (e) {
    console.error("[usageRepo] getRecentLogs failed:", e.message);
    return [];
  }
}
