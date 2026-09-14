// Per-API-key request-rate limit (requests per rolling minute) with a bounded
// queue. Sits beside the token quota in `apiKeyQuota.js`; the difference is the
// dimension: quota counts tokens over hours, this counts requests over seconds.
//
// Three bands, matching the operator's mental model of "6 per minute, burst 12":
//   admitted < limit                     -> forward immediately
//   admitted + waiting < burst           -> queue until the window frees a slot
//   admitted + waiting >= burst          -> reject with 429
//
// `waiting` deliberately does NOT count as `admitted`. If queued requests
// occupied admitted slots, a full queue would pin the window at `burst` forever
// and no queued request could ever be promoted — the queue would deadlock
// instead of draining.
//
// Redis carries shared state across instances; the process-local path is the
// fallback when no Redis is configured (matching `connectionSlots.js`).
import { randomUUID } from "node:crypto";
import { getRedisClient } from "@/lib/redis/client.js";

export const API_KEY_RATE_WINDOW_MS = Math.max(
  500,
  Number.parseInt(process.env.SPRING_MOUSE_API_KEY_RATE_WINDOW_MS, 10) || 60_000,
);
export const API_KEY_RATE_QUEUE_TIMEOUT_MS =
  Math.max(1_000, Number.parseInt(process.env.SPRING_MOUSE_API_KEY_QUEUE_TIMEOUT_MS, 10) || API_KEY_RATE_WINDOW_MS);

const POLL_INTERVAL_MS = 100;
const MAX_RATE_VALUE = 1_000_000;

const encodedKeyId = (keyId) => Buffer.from(String(keyId)).toString("base64url");
const admitKey = (keyId) => `spring-mouse:ratelimit:{apikey}:admit:${encodedKeyId(keyId)}`;
const waitingKey = (keyId) => `spring-mouse:ratelimit:{apikey}:waiting:${encodedKeyId(keyId)}`;

function positiveIntOrNull(value) {
  const parsed = typeof value === "number" ? value : Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.min(Math.floor(parsed), MAX_RATE_VALUE);
}

// Queue length may legitimately be zero ("do not queue, reject immediately"),
// so it needs its own parser instead of the strictly-positive one.
function nonNegativeIntOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.min(parsed, MAX_RATE_VALUE);
}

/**
 * Normalize the instance-wide defaults. Three independent knobs:
 *   rpmLimit        x — requests admitted per rolling minute
 *   rpmQueueMax     y — how many further requests may wait once x is used up
 *   queueTimeoutMs  how long one queued request waits before it is rejected
 *
 * A limit with no queue (y = 0) rejects immediately rather than making callers
 * block, which is the least surprising reading of a single configured number.
 */
export function normalizeApiKeyRateLimitRules(rules = {}) {
  const rpmLimit = positiveIntOrNull(rules?.rpmLimit);
  if (rpmLimit === null) return { rpmLimit: null, rpmQueueMax: 0, queueTimeoutMs: null };
  return {
    rpmLimit,
    rpmQueueMax: nonNegativeIntOrNull(rules?.rpmQueueMax) ?? 0,
    queueTimeoutMs: positiveIntOrNull(rules?.queueTimeoutMs) ?? API_KEY_RATE_QUEUE_TIMEOUT_MS,
  };
}

/**
 * Per-key values win over the instance defaults; `null` inherits. Returns
 * `enabled: false` when nothing is configured, so callers can skip the gate
 * entirely on the hot path.
 *
 * `burst` is the gate's total ceiling — admitted plus waiting — and is the only
 * shape the admission algorithm needs; `queueMax` is how it is configured.
 */
export function resolveApiKeyRateLimit(key, globalRules) {
  const fallback = normalizeApiKeyRateLimitRules(globalRules);
  const limit = positiveIntOrNull(key?.rpmLimit) ?? fallback.rpmLimit;
  if (limit === null) return { enabled: false, limit: null, queueMax: 0, burst: null, queueTimeoutMs: null };
  const queueMax = nonNegativeIntOrNull(key?.rpmQueueMax) ?? fallback.rpmQueueMax;
  const queueTimeoutMs = positiveIntOrNull(key?.queueTimeoutMs) ?? fallback.queueTimeoutMs ?? API_KEY_RATE_QUEUE_TIMEOUT_MS;
  return { enabled: true, limit, queueMax, burst: limit + queueMax, queueTimeoutMs };
}

const TRY_ACQUIRE_SCRIPT = `
local clock = redis.call('TIME')
local now = tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000)
local window = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
local burst = tonumber(ARGV[3])
local member = ARGV[4]

redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now - window)
local admitted = redis.call('ZCARD', KEYS[1])
local waiting = tonumber(redis.call('GET', KEYS[2]) or '0')
if waiting < 0 then waiting = 0 end

if admitted + waiting >= burst then
  local retry = window
  local oldest = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
  if oldest[2] then
    retry = math.floor(tonumber(oldest[2]) + window - now)
    if retry < 1000 then retry = 1000 end
  end
  return {-1, retry}
end

if waiting == 0 and admitted < limit then
  redis.call('ZADD', KEYS[1], now, member)
  redis.call('PEXPIRE', KEYS[1], window * 2)
  return {1, 0}
end

redis.call('INCR', KEYS[2])
redis.call('PEXPIRE', KEYS[2], window * 4)
return {0, 0}
`;

const TRY_PROMOTE_SCRIPT = `
local clock = redis.call('TIME')
local now = tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000)
local window = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
local member = ARGV[3]

redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now - window)
local admitted = redis.call('ZCARD', KEYS[1])
if admitted < limit then
  local waiting = tonumber(redis.call('GET', KEYS[2]) or '0')
  if waiting > 0 then redis.call('DECR', KEYS[2]) end
  redis.call('ZADD', KEYS[1], now, member)
  redis.call('PEXPIRE', KEYS[1], window * 2)
  return {1, 0}
end

local retry = window
local oldest = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
if oldest[2] then
  retry = math.floor(tonumber(oldest[2]) + window - now)
  if retry < 1000 then retry = 1000 end
end
return {0, retry}
`;

const RELEASE_QUEUE_SCRIPT = `
local waiting = tonumber(redis.call('GET', KEYS[1]) or '0')
if waiting > 0 then redis.call('DECR', KEYS[1]) end
return 1
`;

// Next route bundles and dev reloads must share accounting inside one process.
const localState = globalThis.__smApiKeyRateLimit ||= { buckets: new Map() };

function localBucket(keyId) {
  let bucket = localState.buckets.get(keyId);
  if (!bucket) {
    bucket = { admitted: [], waiting: 0 };
    localState.buckets.set(keyId, bucket);
  }
  return bucket;
}

function pruneLocal(bucket, now) {
  const cutoff = now - API_KEY_RATE_WINDOW_MS;
  while (bucket.admitted.length && bucket.admitted[0] <= cutoff) bucket.admitted.shift();
}

function localRetryAfterMs(bucket, now) {
  const oldest = bucket.admitted[0];
  if (oldest === undefined) return API_KEY_RATE_WINDOW_MS;
  return Math.max(1000, Math.floor(oldest + API_KEY_RATE_WINDOW_MS - now));
}

function localTryAcquire(keyId, limit, burst, now) {
  const bucket = localBucket(keyId);
  pruneLocal(bucket, now);
  if (bucket.admitted.length + bucket.waiting >= burst) {
    return { code: -1, retryAfterMs: localRetryAfterMs(bucket, now) };
  }
  if (bucket.waiting === 0 && bucket.admitted.length < limit) {
    bucket.admitted.push(now);
    return { code: 1, retryAfterMs: 0 };
  }
  bucket.waiting += 1;
  return { code: 0, retryAfterMs: 0 };
}

function localTryPromote(keyId, limit, now) {
  const bucket = localBucket(keyId);
  pruneLocal(bucket, now);
  if (bucket.admitted.length < limit) {
    if (bucket.waiting > 0) bucket.waiting -= 1;
    bucket.admitted.push(now);
    return { code: 1, retryAfterMs: 0 };
  }
  return { code: 0, retryAfterMs: localRetryAfterMs(bucket, now) };
}

function releaseLocalQueue(keyId) {
  const bucket = localState.buckets.get(keyId);
  if (!bucket) return;
  if (bucket.waiting > 0) bucket.waiting -= 1;
  if (bucket.waiting === 0 && bucket.admitted.length === 0) localState.buckets.delete(keyId);
}

function sleepInterruptible(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason || new DOMException("Request aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason || new DOMException("Request aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function tryAcquireRedis(client, keyId, limit, burst, member) {
  const result = await client.eval(TRY_ACQUIRE_SCRIPT, {
    keys: [admitKey(keyId), waitingKey(keyId)],
    arguments: [String(API_KEY_RATE_WINDOW_MS), String(limit), String(burst), member],
  });
  return { code: Number(result?.[0] ?? 0), retryAfterMs: Number(result?.[1] ?? 0) };
}

async function tryPromoteRedis(client, keyId, limit, member) {
  const result = await client.eval(TRY_PROMOTE_SCRIPT, {
    keys: [admitKey(keyId), waitingKey(keyId)],
    arguments: [String(API_KEY_RATE_WINDOW_MS), String(limit), member],
  });
  return { code: Number(result?.[0] ?? 0), retryAfterMs: Number(result?.[1] ?? 0) };
}

async function releaseRedisQueue(client, keyId) {
  await client.eval(RELEASE_QUEUE_SCRIPT, { keys: [waitingKey(keyId)], arguments: [] });
}

/**
 * Admit, queue, or reject one request for an API key.
 *
 * Resolves to `{ allowed: true }` once the caller may talk to upstream, or
 * `{ allowed: false, reason, retryAfterMs }` when it must answer 429. A caller
 * that queued and then gave up releases its waiting slot, so the burst headroom
 * is not leaked on timeouts or client disconnects.
 */
export async function acquireApiKeyRateSlot({
  keyId,
  limit,
  burst,
  queueTimeoutMs = API_KEY_RATE_QUEUE_TIMEOUT_MS,
  signal = null,
} = {}) {
  if (!keyId) return { allowed: true, waitedMs: 0 };
  const effectiveLimit = positiveIntOrNull(limit);
  if (effectiveLimit === null) return { allowed: true, waitedMs: 0 };
  const effectiveBurst = Math.max(effectiveLimit, positiveIntOrNull(burst) ?? effectiveLimit);

  const member = randomUUID();
  const startedAt = Date.now();
  const deadline = startedAt + Math.max(0, Number(queueTimeoutMs) || 0);
  const client = await getRedisClient({ required: false }).catch(() => null);
  let redis = Boolean(client);

  // Rebuild the three gates whenever the backend switches, so acquire/promote/
  // release always address the same counter. Mixing a Redis acquire with a local
  // release would leak waiting slots in both stores.
  const buildGates = () => ({
    acquire: redis
      ? () => tryAcquireRedis(client, keyId, effectiveLimit, effectiveBurst, member)
      : async () => localTryAcquire(keyId, effectiveLimit, effectiveBurst, Date.now()),
    promote: redis
      ? () => tryPromoteRedis(client, keyId, effectiveLimit, member)
      : async () => localTryPromote(keyId, effectiveLimit, Date.now()),
    release: redis
      ? () => releaseRedisQueue(client, keyId).catch(() => {})
      : async () => releaseLocalQueue(keyId),
  });
  let gates = buildGates();

  let first;
  try {
    first = await gates.acquire();
  } catch {
    // Redis is the shared gate, but it must not become a single point of
    // failure: degrade to the process-local counter for this request.
    redis = false;
    gates = buildGates();
    first = localTryAcquire(keyId, effectiveLimit, effectiveBurst, Date.now());
  }

  if (first.code === 1) return { allowed: true, waitedMs: 0 };
  if (first.code === -1) {
    return { allowed: false, reason: "burst_exceeded", retryAfterMs: first.retryAfterMs || API_KEY_RATE_WINDOW_MS };
  }

  // code 0: queued. Poll until a slot opens, the queue budget runs out, or the
  // client goes away.
  let settled = false;
  let promoteFailures = 0;
  try {
    while (Date.now() < deadline) {
      const remaining = deadline - Date.now();
      await sleepInterruptible(Math.min(POLL_INTERVAL_MS, Math.max(1, remaining)), signal);
      let attempt;
      try {
        attempt = await gates.promote();
        promoteFailures = 0;
      } catch {
        // Tolerate a flapping Redis by giving up the queue slot instead of
        // answering 429 for what is really a limiter outage.
        if (++promoteFailures >= 3) {
          settled = true;
          await gates.release().catch(() => {});
          return { allowed: true, waitedMs: Date.now() - startedAt, queued: true, degraded: true };
        }
        continue;
      }
      if (attempt.code === 1) {
        settled = true;
        return { allowed: true, waitedMs: Date.now() - startedAt, queued: true };
      }
    }
    return {
      allowed: false,
      reason: "queue_timeout",
      retryAfterMs: API_KEY_RATE_WINDOW_MS,
      waitedMs: Date.now() - startedAt,
    };
  } catch (error) {
    if (signal?.aborted) return { allowed: false, reason: "aborted", retryAfterMs: 0 };
    throw error;
  } finally {
    if (!settled) await gates.release().catch(() => {});
  }
}

/** Live counters for one key, used by diagnostics and the credentials page. */
export async function getApiKeyRateLimitSnapshot(keyId, limit, burst) {
  const effectiveLimit = positiveIntOrNull(limit);
  if (effectiveLimit === null) return null;
  const effectiveBurst = Math.max(effectiveLimit, positiveIntOrNull(burst) ?? effectiveLimit);
  const now = Date.now();

  const client = await getRedisClient({ required: false }).catch(() => null);
  if (client) {
    try {
      const [admitted, waiting] = await Promise.all([
        client.eval(
          `local clock = redis.call('TIME')
           local now = tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000)
           redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now - tonumber(ARGV[1]))
           return redis.call('ZCARD', KEYS[1])`,
          { keys: [admitKey(keyId)], arguments: [String(API_KEY_RATE_WINDOW_MS)] },
        ),
        client.get(waitingKey(keyId)),
      ]);
      return {
        limit: effectiveLimit,
        burst: effectiveBurst,
        admitted: Number(admitted) || 0,
        waiting: Math.max(0, Number(waiting) || 0),
        windowMs: API_KEY_RATE_WINDOW_MS,
        source: "redis",
      };
    } catch {
      // fall through to the local view
    }
  }

  const bucket = localState.buckets.get(keyId);
  if (!bucket) {
    return { limit: effectiveLimit, burst: effectiveBurst, admitted: 0, waiting: 0, windowMs: API_KEY_RATE_WINDOW_MS, source: "local" };
  }
  pruneLocal(bucket, now);
  return {
    limit: effectiveLimit,
    burst: effectiveBurst,
    admitted: bucket.admitted.length,
    waiting: Math.max(0, bucket.waiting),
    windowMs: API_KEY_RATE_WINDOW_MS,
    source: "local",
  };
}
