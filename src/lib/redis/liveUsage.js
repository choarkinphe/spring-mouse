import { getRedisClient, isRedisConfigured } from "./client.js";

export const USAGE_STREAM_KEY = "spring-mouse:usage:events";
export const USAGE_STREAM_GROUP = "sqlite-writers";
const RECENT_USAGE_KEY = "spring-mouse:usage:recent";
const STATS_CACHE_PREFIX = "spring-mouse:stats:";
const STATS_CACHE_TTL_SECONDS = 3;
const RECENT_USAGE_CAP = 200;
const USAGE_DEDUPE_TTL_SECONDS = 8 * 24 * 60 * 60;
const WRITER_HEARTBEAT_KEY = "spring-mouse:usage:writer:heartbeat";
const ACTIVE_FLOW_PREFIX = "spring-mouse:active:flow:";
export const USAGE_COMMITTED_CHANNEL = "spring-mouse:usage:committed";
let commitSubscriber = null;

export function quotaCounterKey(apiKeyId, windowId, resetAt) {
  return `spring-mouse:quota:${apiKeyId}:${windowId}:${resetAt}`;
}

export async function getQuotaCounter(apiKeyId, windowId, resetAt) {
  const client = await getRedisClient({ required: false });
  if (!client) return null;
  const value = await client.get(quotaCounterKey(apiKeyId, windowId, resetAt));
  return value === null ? null : Number(value) || 0;
}

export async function initializeQuotaCounter(apiKeyId, windowId, resetAt, value) {
  const client = await getRedisClient({ required: false });
  if (!client) return Number(value) || 0;
  const key = quotaCounterKey(apiKeyId, windowId, resetAt);
  const expiresAt = Math.max(Date.now() + 60000, new Date(resetAt).getTime() + 86400000);
  await client.sendCommand(["SET", key, String(Number(value) || 0), "NX", "PXAT", String(expiresAt)]);
  return Number(await client.get(key)) || 0;
}

export async function deleteQuotaCounters(apiKeyId) {
  if (!apiKeyId) return;
  const client = await getRedisClient({ required: false });
  if (!client) return;
  let cursor = "0";
  do {
    const reply = await client.scan(cursor, { MATCH: `spring-mouse:quota:${apiKeyId}:*`, COUNT: 100 });
    cursor = reply.cursor;
    if (reply.keys.length) await client.del(reply.keys);
  } while (cursor !== "0");
}

export async function enqueueUsageEvent(event, quotaCounters = []) {
  const client = await getRedisClient({ required: false });
  if (!client) return false;

  if (!event?.requestId) throw new Error("Usage events require requestId for idempotent enqueue");
  const payload = JSON.stringify(event);
  const dedupeKey = `spring-mouse:usage:seen:${Buffer.from(String(event.requestId)).toString("base64url")}`;
  const keys = [USAGE_STREAM_KEY, RECENT_USAGE_KEY, dedupeKey, ...quotaCounters.map((item) => item.key)];
  const args = [payload, String(RECENT_USAGE_CAP), String(USAGE_DEDUPE_TTL_SECONDS), String(quotaCounters.length)];
  for (const item of quotaCounters) args.push(String(item.delta || 0));

  const script = `
    local payload = ARGV[1]
    local recentCap = tonumber(ARGV[2])
    local dedupeTtl = tonumber(ARGV[3])
    local quotaCount = tonumber(ARGV[4])
    if redis.call('EXISTS', KEYS[3]) == 1 then
      return 'duplicate'
    end
    local streamId = redis.call('XADD', KEYS[1], '*', 'event', payload)
    redis.call('SET', KEYS[3], '1', 'EX', dedupeTtl)
    redis.call('LPUSH', KEYS[2], payload)
    redis.call('LTRIM', KEYS[2], 0, recentCap - 1)
    for i = 1, quotaCount do
      local quotaKey = KEYS[i + 3]
      if redis.call('EXISTS', quotaKey) == 1 then
        redis.call('INCRBY', quotaKey, tonumber(ARGV[i + 4]))
      end
    end
    return streamId
  `;

  await client.eval(script, { keys, arguments: args });
  return true;
}

export async function updateActiveFlow(flowId, metadata, delta) {
  const client = await getRedisClient({ required: false });
  if (!client) return false;
  const key = `${ACTIVE_FLOW_PREFIX}${flowId}`;
  const script = `
    local count = redis.call('HINCRBY', KEYS[1], 'count', tonumber(ARGV[1]))
    if count <= 0 then
      redis.call('DEL', KEYS[1])
      return 0
    end
    redis.call('HSET', KEYS[1],
      'model', ARGV[2],
      'provider', ARGV[3],
      'connectionId', ARGV[4],
      'updatedAt', ARGV[5])
    redis.call('EXPIRE', KEYS[1], 120)
    return count
  `;
  await client.eval(script, {
    keys: [key],
    arguments: [
      String(delta),
      metadata.model || "unknown",
      metadata.provider || "unknown",
      metadata.connectionId || "",
      String(Date.now()),
    ],
  });
  return true;
}

export async function getRecentUsageEvents(limit = 50) {
  const client = await getRedisClient({ required: false });
  if (!client) return null;
  const rows = await client.lRange(RECENT_USAGE_KEY, 0, Math.max(0, limit - 1));
  return rows.map((row) => {
    try { return JSON.parse(row); } catch { return null; }
  }).filter(Boolean);
}

function statsCacheKey(key) {
  return `${STATS_CACHE_PREFIX}${Buffer.from(key).toString("base64url")}`;
}

export async function getCachedUsageStats(key) {
  const client = await getRedisClient({ required: false });
  if (!client) return null;
  const value = await client.get(statsCacheKey(key));
  if (!value) return null;
  try { return JSON.parse(value); } catch { return null; }
}

export async function setCachedUsageStats(key, stats) {
  const client = await getRedisClient({ required: false });
  if (!client) return false;
  await client.set(statsCacheKey(key), JSON.stringify(stats), { expiration: { type: "EX", value: STATS_CACHE_TTL_SECONDS } });
  return true;
}

export async function getUsageQueueHealth() {
  if (!isRedisConfigured()) return { configured: false, pending: 0, length: 0 };
  const client = await getRedisClient({ required: false });
  if (!client) return { configured: true, pending: null, length: null };
  const length = await client.xLen(USAGE_STREAM_KEY);
  let pending = 0;
  try {
    const summary = await client.xPending(USAGE_STREAM_KEY, USAGE_STREAM_GROUP);
    pending = Number(summary?.pending ?? summary ?? 0) || 0;
  } catch {}
  const heartbeat = await client.get(WRITER_HEARTBEAT_KEY);
  const heartbeatAgeMs = heartbeat ? Math.max(0, Date.now() - Number(heartbeat)) : null;
  return {
    configured: true,
    pending,
    length,
    writerHealthy: heartbeatAgeMs !== null && heartbeatAgeMs < 15000,
    writerHeartbeatAgeMs: heartbeatAgeMs,
  };
}

export async function startUsageCommitSubscriber(onCommit) {
  if (commitSubscriber || typeof onCommit !== "function") return false;
  const client = await getRedisClient({ required: false });
  if (!client) return false;
  const subscriber = client.duplicate();
  subscriber.on("error", (error) => console.error("[UsageSubscriber] Redis:", error.message));
  await subscriber.connect();
  await subscriber.subscribe(USAGE_COMMITTED_CHANNEL, () => onCommit());
  commitSubscriber = subscriber;
  return true;
}

export async function stopUsageCommitSubscriber() {
  const subscriber = commitSubscriber;
  commitSubscriber = null;
  if (!subscriber?.isOpen) return;
  try { await subscriber.unsubscribe(USAGE_COMMITTED_CHANNEL); } catch {}
  try { await subscriber.quit(); } catch { try { subscriber.destroy(); } catch {} }
}
