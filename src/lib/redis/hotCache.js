import { routingRedis } from "./routingClient.js";

const PREFIX = "spring-mouse:hot:v1:";
const DEFAULT_TTL_SECONDS = 60;

function fullKey(key) {
  return `${PREFIX}${key}`;
}

// Collapse simultaneous GETs only, not a TTL cache: key revocation/permission
// changes must not acquire another process-local stale-data window.
const pendingReads = new Map();
export async function getHotJson(key) {
  let pending = pendingReads.get(key);
  if (!pending) {
    pending = routingRedis((client) => client.get(fullKey(key)));
    if (pendingReads.size < 1024) pendingReads.set(key, pending);
    pending.finally(() => { if (pendingReads.get(key) === pending) pendingReads.delete(key); });
  }
  try {
    const raw = await pending;
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

export async function setHotJson(key, value, ttlSeconds = DEFAULT_TTL_SECONDS) {
  pendingReads.delete(key);
  try {
    return await routingRedis((client) => client.set(fullKey(key), JSON.stringify(value), {
      EX: Math.max(1, Math.floor(Number(ttlSeconds) || DEFAULT_TTL_SECONDS)),
    })) !== null;
  } catch { return false; }
}

export async function deleteHotJson(key) {
  pendingReads.delete(key);
  return await routingRedis((client) => client.del(fullKey(key))) !== null;
}

export async function incrementHotCounter(key, ttlSeconds = 120) {
  const result = await routingRedis((client) => client.eval(`
    local value = redis.call('INCR', KEYS[1])
    redis.call('EXPIRE', KEYS[1], tonumber(ARGV[1]))
    return value
  `, { keys: [fullKey(key)], arguments: [String(Math.max(1, Math.floor(Number(ttlSeconds) || 120)))] }));
  return result === null ? null : Number(result);
}
