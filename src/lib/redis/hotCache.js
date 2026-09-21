import { routingRedis } from "./routingClient.js";

const PREFIX = "spring-mouse:hot:v1:";
const DEFAULT_TTL_SECONDS = 60;

// A read-through fill is "read the DB, then cache the result". If a writer
// invalidates the key *between* those two steps, a plain SET (or a bare DEL on
// the writer side) lets the slow reader land its pre-write snapshot afterwards
// and resurrect it — the model list a user just synced flashes and then reverts.
//
// Invalidation therefore writes this marker instead of deleting the key, and
// read-through fills use SET NX: while the marker is present the stale fill is a
// no-op, so the next read rebuilds from the database. The TTL only has to
// outlast the slowest in-flight fill (one local SQLite read plus one Redis round
// trip, i.e. milliseconds), so it stays short — it is also the window in which
// reads skip the cache, so a long value would make every write cold-start the
// hot paths (combo lookup and API-key auth run per request).
const INVALIDATION_MARKER = "__spring_mouse_hot_invalidated__";
const INVALIDATION_TTL_SECONDS = 5;

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
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    // An invalidation marker is a miss, not a value.
    return parsed === INVALIDATION_MARKER ? null : parsed;
  } catch { return null; }
}

// Authoritative write (the caller holds the freshly-persisted value). Always
// wins, including over an invalidation marker.
export async function setHotJson(key, value, ttlSeconds = DEFAULT_TTL_SECONDS) {
  pendingReads.delete(key);
  try {
    return await routingRedis((client) => client.set(fullKey(key), JSON.stringify(value), {
      EX: Math.max(1, Math.floor(Number(ttlSeconds) || DEFAULT_TTL_SECONDS)),
    })) !== null;
  } catch { return false; }
}

// Read-through fill: cache a value that was just read from the DB, but only if
// nothing has written or invalidated the key in the meantime. Use this (never
// setHotJson) on the "read miss -> read DB -> populate cache" path.
export async function fillHotJson(key, value, ttlSeconds = DEFAULT_TTL_SECONDS) {
  pendingReads.delete(key);
  try {
    return await routingRedis((client) => client.set(fullKey(key), JSON.stringify(value), {
      EX: Math.max(1, Math.floor(Number(ttlSeconds) || DEFAULT_TTL_SECONDS)),
      condition: "NX",
    })) !== null;
  } catch { return false; }
}

export async function deleteHotJson(key) {
  pendingReads.delete(key);
  try {
    return await routingRedis((client) => client.set(fullKey(key), JSON.stringify(INVALIDATION_MARKER), {
      EX: INVALIDATION_TTL_SECONDS,
    })) !== null;
  } catch { return false; }
}

export async function incrementHotCounter(key, ttlSeconds = 120) {
  const result = await routingRedis((client) => client.eval(`
    local value = redis.call('INCR', KEYS[1])
    redis.call('EXPIRE', KEYS[1], tonumber(ARGV[1]))
    return value
  `, { keys: [fullKey(key)], arguments: [String(Math.max(1, Math.floor(Number(ttlSeconds) || 120)))] }));
  return result === null ? null : Number(result);
}
