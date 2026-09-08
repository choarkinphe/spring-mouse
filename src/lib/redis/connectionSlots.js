import { getRedisClient } from "./client.js";

const PREFIX = "spring-mouse:routing:connection:";
const DEFAULT_MAX_CONCURRENT_STREAMS = Math.max(1, Number.parseInt(process.env.SPRING_MOUSE_CONNECTION_MAX_CONCURRENCY || "16", 10) || 4);
const SLOT_TTL_SECONDS = Math.max(60, Number.parseInt(process.env.SPRING_MOUSE_CONNECTION_SLOT_TTL_SECONDS || "1800", 10) || 1800);

function slotKey(connectionId) {
  return `${PREFIX}${connectionId}:active`;
}

function normalizedLimit(value) {
  const limit = Number.parseInt(value, 10);
  return Number.isFinite(limit) && limit > 0 ? limit : null;
}

export function getConnectionConcurrencyLimit(connection, providerStrategy = {}) {
  return normalizedLimit(connection?.providerSpecificData?.maxConcurrentStreams)
    || normalizedLimit(providerStrategy?.maxConcurrentStreams)
    || DEFAULT_MAX_CONCURRENT_STREAMS;
}

/**
 * Atomically reserve one upstream slot. `null` means Redis is unavailable and
 * callers should fail open rather than turning a cache outage into an AI outage.
 */
export async function reserveConnectionSlot(connectionId, maxConcurrentStreams) {
  if (!connectionId || connectionId === "noauth") return null;
  try {
    const client = await getRedisClient({ required: false });
    if (!client) return null;
    const result = await client.eval(`
      local active = tonumber(redis.call('GET', KEYS[1]) or '0')
      local limit = tonumber(ARGV[1])
      if active >= limit then return 0 end
      active = redis.call('INCR', KEYS[1])
      redis.call('EXPIRE', KEYS[1], tonumber(ARGV[2]))
      return active
    `, {
      keys: [slotKey(connectionId)],
      arguments: [String(maxConcurrentStreams), String(SLOT_TTL_SECONDS)],
    });
    return Number(result) > 0;
  } catch {
    return null;
  }
}

export async function releaseConnectionSlot(connectionId) {
  if (!connectionId || connectionId === "noauth") return false;
  try {
    const client = await getRedisClient({ required: false });
    if (!client) return false;
    await client.eval(`
      local active = tonumber(redis.call('GET', KEYS[1]) or '0')
      if active <= 1 then redis.call('DEL', KEYS[1]); return 0 end
      return redis.call('DECR', KEYS[1])
    `, { keys: [slotKey(connectionId)], arguments: [] });
    return true;
  } catch {
    return false;
  }
}

export async function getConnectionSlotUsage(connectionIds = []) {
  try {
    const client = await getRedisClient({ required: false });
    if (!client || !connectionIds.length) return null;
    const values = await client.mGet(connectionIds.map(slotKey));
    return Object.fromEntries(connectionIds.map((id, index) => [id, Number(values[index]) || 0]));
  } catch {
    return null;
  }
}
