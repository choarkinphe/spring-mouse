import { randomUUID } from "node:crypto";
import { routingRedis } from "./routingClient.js";
import { ADMISSION_CONFIG } from "./admissionConfig.js";

const positive = (value, fallback) => Math.max(1, Number.parseInt(value, 10) || fallback);
const bounded = (value, fallback, max) => Math.min(positive(value, fallback), max);
const DEFAULT_LIMIT = positive(process.env.SPRING_MOUSE_CONNECTION_MAX_CONCURRENCY, 16);
const LEASE_MS = Math.max(3000, positive(process.env.SPRING_MOUSE_CONNECTION_SLOT_TTL_SECONDS, 90) * 1000);
// A caller that waited out the whole queue window without being admitted proves
// the gate stayed saturated for that entire period. Advertising the observed
// window is the honest hint; the former hardcoded 1s told every client to retry
// almost immediately, so they re-queued for another full window in lockstep.
const QUEUE_RETRY_AFTER_MIN_MS = positive(process.env.SPRING_MOUSE_QUEUE_RETRY_AFTER_MIN_MS, 5_000);
const QUEUE_RETRY_AFTER_MAX_MS = Math.max(
  QUEUE_RETRY_AFTER_MIN_MS,
  positive(process.env.SPRING_MOUSE_QUEUE_RETRY_AFTER_MAX_MS, 60_000),
);
const queueRetryAfterMs = (timeoutMs) =>
  Math.min(QUEUE_RETRY_AFTER_MAX_MS, Math.max(QUEUE_RETRY_AFTER_MIN_MS, Number(timeoutMs) || 0));
// Distinct v3 keys avoid mixing hard-capacity leases with former soft counters.
const slotKey = (id) => `spring-mouse:routing:{routing}:slots:v3:${id}`;
const providerKey = (providerId) => `spring-mouse:routing:{routing}:provider:v1:${providerId}`;
const queueKey = (providerId) => `spring-mouse:routing:{routing}:queue:v2:${providerId}`;
// Next route bundles and development reloads must share process accounting.
const state = globalThis.__smConnectionLeases ||= {
  active: new Map(), renewalTimer: null, renewing: false, waiters: new Map(),
};
const { active } = state;
const localQueues = state.waiters ||= new Map();

export class RoutingQueueTimeoutError extends Error {
  constructor(providerId, timeoutMs, retryAfterMs = null, reason = "queue_timeout") {
    super(`${providerId} admission ${reason} after ${timeoutMs}ms`);
    this.name = "RoutingQueueTimeoutError";
    this.code = "ROUTING_QUEUE_TIMEOUT";
    this.providerId = providerId;
    this.reason = reason;
    // How long the request actually waited before giving up. Kept separate from
    // the advisory delay so logs report the real figure.
    this.queueTimeoutMs = timeoutMs;
    this.retryAfterMs = retryAfterMs ?? queueRetryAfterMs(timeoutMs);
  }
}

export function getConnectionConcurrencyLimit(connection, providerStrategy = {}) {
  return positive(connection?.providerSpecificData?.maxConcurrentStreams,
    positive(providerStrategy?.maxConcurrentStreams, DEFAULT_LIMIT));
}

/** Heuristic weights must not collapse a multi-request account into a serial
 * queue. E.g. a cap of 15 needs weights <=7 to admit two large requests. Explicit
 * reservation weights remain strict; this ceiling applies to estimation only. */
export function getRequestWeightLimit(candidates, providerLimit) {
  const largestAccount = Math.max(1, ...candidates.map(c => positive(c.limit, DEFAULT_LIMIT)));
  const capacity = Number.isFinite(providerLimit) && providerLimit > 0
    ? Math.min(largestAccount, providerLimit) : largestAccount;
  return Math.max(1, Math.min(ADMISSION_CONFIG.maxWeight,
    Math.floor(capacity / ADMISSION_CONFIG.minParallelRequests)));
}

/**
 * Approximate expensive long-context requests with a small integer weight so a
 * 1,400-message Codex turn cannot consume the same gate capacity as a two-turn
 * request. The caps keep a malformed giant body from creating a huge lease.
 */
export function estimateRequestWeight(body = {}, maxWeight = ADMISSION_CONFIG.maxWeight) {
  const cap = positive(maxWeight, ADMISSION_CONFIG.maxWeight);
  const ceiling = cap * ADMISSION_CONFIG.charsPerSlot;
  let chars = 0, nodes = 0;
  // Walk without serializing/copying a multi-MB request. Stop once the weight
  // is saturated; tools count by schema size, not by number of definitions.
  function visit(value, depth = 0) {
    if (chars >= ceiling) return;
    if (++nodes > ADMISSION_CONFIG.maxSizeNodes || depth > ADMISSION_CONFIG.maxSizeDepth) { chars = ceiling; return; }
    if (typeof value === "string") { chars += value.length; return; }
    if (!value || typeof value !== "object") return;
    chars += ADMISSION_CONFIG.structureChars;
    for (const key in value) {
      if (!Object.hasOwn(value, key)) continue;
      chars += key.length;
      visit(value[key], depth + 1);
      if (chars >= ceiling) break;
    }
  }
  for (const key of ["messages", "input", "tools", "system", "instructions"]) visit(body?.[key]);
  return Math.min(cap, Math.max(1, Math.ceil(chars / ADMISSION_CONFIG.charsPerSlot)));
}

// Enrollment and queue capacity are one atomic operation across all workers.
export const ENQUEUE_SCRIPT = `
local clock = redis.call('TIME')
local now = tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000)
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
if ARGV[5] and ARGV[5] ~= '' then redis.call('ZREM', KEYS[1], ARGV[5]) end
if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[1]) then return -1 end
local expires = math.min(tonumber(ARGV[2]), now + tonumber(ARGV[6] or ARGV[4]))
redis.call('ZADD', KEYS[1], expires, ARGV[3])
redis.call('PEXPIRE', KEYS[1], ARGV[4])
return 1
`;

/** KEYS: provider, queue, accounts; ARGV: lease, TTL, provider cap, weight,
 * account caps, JSON ticket, maximum bypass age, waiter TTL, deadline. */
export const HARD_RESERVE_SCRIPT = `
local clock = redis.call('TIME')
local now = tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000)
local provider, queue = KEYS[1], KEYS[2]
local lease, lease_ms = ARGV[1], tonumber(ARGV[2])
local provider_limit, weight = tonumber(ARGV[3]), tonumber(ARGV[4])
local ticket = ARGV[#KEYS + 3]
local bypass_ms = tonumber(ARGV[#KEYS + 4])
local own = cjson.decode(ticket)
local expires = now + lease_ms
redis.call('ZREMRANGEBYSCORE', queue, '-inf', now)
if not redis.call('ZSCORE', queue, ticket) then return -1 end
-- A dead/disconnected worker cannot reserve idle capacity for a full minute.
local waiter_ttl = tonumber(ARGV[#KEYS + 5] or '3000')
local deadline = tonumber(ARGV[#KEYS + 6] or tostring(now + waiter_ttl))
redis.call('ZADD', queue, math.min(deadline, now + waiter_ttl), ticket)
-- Short requests can use spare capacity briefly. Once a competing waiter has
-- aged, reserve its overlapping accounts so a stream of newcomers cannot starve
-- it. Disjoint account sets (e.g. capability/pinned routes) do not block each other.
local protected = {}
for _, raw in ipairs(redis.call('ZRANGE', queue, 0, -1)) do
  local older = cjson.decode(raw)
  if older.at < own.at or (older.at == own.at and older.id < own.id) then
    if now - older.at >= bypass_ms then
      for _, key in ipairs(older.keys) do protected[key] = true end
    end
  end
end
redis.call('ZREMRANGEBYSCORE', provider, '-inf', now)
if tonumber(redis.call('ZCARD', provider)) + weight > provider_limit then return 0 end
for i = 3, #KEYS do
  local key = KEYS[i]
  if not protected[key] then
    redis.call('ZREMRANGEBYSCORE', key, '-inf', now)
    if tonumber(redis.call('ZCARD', key)) + weight <= tonumber(ARGV[i + 2]) then
      for n = 0, weight - 1 do
        local member = lease .. '#' .. n
        redis.call('ZADD', provider, expires, member)
        redis.call('ZADD', key, expires, member)
      end
      redis.call('PEXPIRE', provider, lease_ms * 2)
      redis.call('PEXPIRE', key, lease_ms * 2)
      redis.call('ZREM', queue, ticket)
      return i - 2
    end
  end
end
return 0
`;

export const RENEW_SCRIPT = `
local clock = redis.call('TIME')
local now = tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000)
for i, key in ipairs(KEYS) do
  -- XX prevents a delayed heartbeat resurrecting a released request.
  redis.call('ZADD', key, 'XX', now + tonumber(ARGV[1]), ARGV[i + 1])
  if redis.call('EXISTS', key) == 1 then redis.call('PEXPIRE', key, tonumber(ARGV[1]) * 2) end
end
return #KEYS
`;

function armRenewal() {
  if (state.renewalTimer || !active.size) return;
  state.renewalTimer = setInterval(async () => {
    if (state.renewing) return;
    const leases = [...active.values()].filter((lease) => lease.redis && lease.renewKeys?.length);
    if (!leases.length) return;
    state.renewing = true;
    try {
      const keys = leases.flatMap((lease) => lease.renewKeys);
      const members = leases.flatMap((lease) => lease.renewMembers);
      await routingRedis((client) => client.eval(RENEW_SCRIPT, {
        keys, arguments: [String(LEASE_MS), ...members],
      }));
    } finally { state.renewing = false; }
  }, Math.floor(LEASE_MS / 3));
  state.renewalTimer.unref?.();
}

function localCounts(providerId) {
  let provider = 0;
  const accounts = new Map();
  for (const lease of active.values()) {
    if (providerId && lease.providerId !== providerId) continue;
    provider += lease.weight || 1;
    accounts.set(lease.connectionId, (accounts.get(lease.connectionId) || 0) + (lease.weight || 1));
  }
  return { provider, accounts };
}

function sleepInterruptible(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason || new DOMException("Request aborted", "AbortError"));
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

function throwIfAborted(signal) {
  if (signal?.aborted) throw signal.reason || new DOMException("Request aborted", "AbortError");
}

/** One deadline and queue ticket survive account refreshes and Redis fallback. */
export async function reserveConnectionSlot(candidates, options = {}) {
  throwIfAborted(options.signal);
  if (!candidates.length) throw new Error("No eligible accounts for reservation");
  const id = randomUUID();
  const started = Date.now();
  const providerId = String(options.providerId || candidates[0].providerId || "provider");
  const weight = bounded(options.weight, 1, ADMISSION_CONFIG.maxWeight);
  const configuredTimeout = positive(options.queueTimeoutMs, 60_000);
  const deadline = Math.min(started + configuredTimeout, options.deadlineMs ?? Infinity);
  const timeout = (reason = "queue_timeout") => new RoutingQueueTimeoutError(
    providerId, Math.max(0, Date.now() - started), null, reason,
  );
  const timeoutReason = () => Number.isFinite(options.deadlineMs) && options.deadlineMs <= Date.now() ? "deadline_exceeded" : "queue_timeout";
  if (deadline <= started) throw timeout("deadline_exceeded");
  const maxQueueSize = positive(options.maxQueueSize, 50);
  const queue = queueKey(providerId);
  const ticket = { id, at: started, keys: candidates.filter(c => c.limit >= weight).map(c => slotKey(c.id)) };
  let rawTicket = JSON.stringify(ticket);
  let redisAvailable = true, nextRefresh = started + ADMISSION_CONFIG.refreshCandidatesMs;
  let localQueue = localQueues.get(providerId);
  if (!localQueue) { localQueue = new Map(); localQueues.set(providerId, localQueue); }
  if (localQueue.size >= maxQueueSize) throw timeout("queue_full");
  localQueue.set(id, ticket);
  const enqueue = (previousTicket = "") => routingRedis(client => client.eval(ENQUEUE_SCRIPT, {
    keys: [queue], arguments: [String(maxQueueSize), String(deadline), rawTicket, String(configuredTimeout * 2), previousTicket, String(ADMISSION_CONFIG.waiterLeaseMs)],
  }));
  try {
    const admitted = await enqueue();
    throwIfAborted(options.signal);
    if (admitted === -1) throw timeout("queue_full");
    redisAvailable = admitted != null;
    while (Date.now() < deadline) {
      throwIfAborted(options.signal);
      if (options.refreshCandidates && Date.now() >= nextRefresh) {
        candidates = await options.refreshCandidates();
        throwIfAborted(options.signal);
        nextRefresh = Date.now() + ADMISSION_CONFIG.refreshCandidatesMs;
        const previousTicket = rawTicket;
        ticket.keys = candidates.filter(c => c.limit >= weight).map(c => slotKey(c.id));
        rawTicket = JSON.stringify(ticket);
        if (redisAvailable) {
          const result = await enqueue(previousTicket);
          if (result === -1) throw timeout("queue_full");
          redisAvailable = result != null;
        }
      }
      const providerLimit = Number.isFinite(options.providerLimit) ? positive(options.providerLimit, 1)
        : candidates.reduce((sum, c) => sum + positive(c.limit, DEFAULT_LIMIT), 0);
      // Impossible weights must not hold a fairness reservation for a minute.
      if (candidates.length && (weight > providerLimit || candidates.every(c => weight > c.limit))) {
        throw timeout("weight_exceeds_capacity");
      }
      let index = null;
      if (redisAvailable && candidates.length && Date.now() < deadline) {
        index = await routingRedis(client => client.eval(HARD_RESERVE_SCRIPT, {
          keys: [providerKey(providerId), queue, ...candidates.map(c => slotKey(c.id))],
          arguments: [id, String(LEASE_MS), String(providerLimit), String(weight),
            ...candidates.map(c => String(c.limit)), rawTicket, String(ADMISSION_CONFIG.maxBypassMs), String(ADMISSION_CONFIG.waiterLeaseMs), String(deadline)],
        }));
        if (index == null) redisAvailable = false;
        else if (index === -1) {
          // A slow event loop can outlive its waiter heartbeat. Rejoin with the
          // same age and deadline; this is not a new waiting budget.
          if (Date.now() >= deadline) break;
          const again = await enqueue();
          if (again === -1) throw timeout("queue_full");
          redisAvailable = again != null;
          continue;
        }
      }
      if (!redisAvailable && candidates.length) {
        const counts = localCounts(providerId);
        const protectedKeys = new Set([...localQueue.values()]
          .filter(t => (t.at < started || (t.at === started && t.id < id)) && Date.now() - t.at >= ADMISSION_CONFIG.maxBypassMs)
          .flatMap(t => t.keys));
        const chosen = candidates.findIndex(c => !protectedKeys.has(slotKey(c.id)) && (counts.accounts.get(c.id) || 0) + weight <= c.limit);
        index = counts.provider + weight <= providerLimit && chosen >= 0 ? chosen + 1 : 0;
      }
      if (index >= 1 && index <= candidates.length) {
        const chosen = candidates[index - 1];
        const lease = { id, connectionId: chosen.id, providerId, weight, redis: redisAvailable,
          members: Array.from({ length: weight }, (_, n) => `${id}#${n}`),
        };
        // Each weighted member belongs to BOTH counters. The heartbeat pairs
        // one member with each key, so expand both arrays in the same order.
        lease.renewKeys = lease.members.flatMap(() => [providerKey(providerId), slotKey(chosen.id)]);
        lease.renewMembers = lease.members.flatMap(member => [member, member]);
        active.set(id, lease);
        const result = makeHardLease(lease, options.signal, Date.now() - started, weight);
        try {
          throwIfAborted(options.signal);
          if (Date.now() >= deadline) throw timeout(timeoutReason());
          if (options.validateCandidate && !await options.validateCandidate(chosen.id)) {
            await result.release();
            nextRefresh = 0;
            // Admission consumed the Redis ticket; keep its original priority.
            if (redisAvailable) {
              const again = await enqueue();
              if (again === -1) throw timeout("queue_full");
              redisAvailable = again != null;
            }
            continue;
          }
          throwIfAborted(options.signal);
          if (Date.now() >= deadline) throw timeout(timeoutReason());
          return result;
        } catch (error) { await result.release(); throw error; }
      }
      // A combo with remaining alternatives only tries currently available
      // capacity. Keep the same atomic limits/fairness and release its ticket
      // before the caller moves to another provider.
      if (options.waitForCapacity === false) throw timeout("capacity_exhausted");
      const remaining = deadline - Date.now();
      if (remaining > 0) await sleepInterruptible(Math.min(ADMISSION_CONFIG.pollMs, remaining), options.signal);
    }
    throw timeout(timeoutReason());
  } finally {
    localQueue.delete(id);
    if (!localQueue.size) localQueues.delete(providerId);
    // Even a timed-out Redis operation may have enrolled the ticket.
    await routingRedis(client => client.zRem(queue, rawTicket));
  }
}

function makeHardLease(lease, signal, queueWaitMs, weight) {
  const release = async () => {
    signal?.removeEventListener("abort", onAbort);
    if (!active.delete(lease.id)) return;
    if (!active.size) { clearInterval(state.renewalTimer); state.renewalTimer = null; }
    if (lease.redis) await routingRedis(async client => {
      await client.zRem(providerKey(lease.providerId), lease.members);
      await client.zRem(slotKey(lease.connectionId), lease.members);
    });
  };
  const onAbort = () => { release().catch(() => {}); };
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) onAbort();
  else armRenewal();
  return { connectionId: lease.connectionId, queueWaitMs, weight, release };
}

/**
 * Live slot usage keyed by connection id, weighted the same way admission
 * counts it (a long-context turn can hold more than one slot). Reflects the
 * requests this process is serving right now.
 */
export function getConnectionSlotCounts() {
  const counts = {};
  for (const lease of active.values()) {
    counts[lease.connectionId] = (counts[lease.connectionId] || 0) + (lease.weight || 1);
  }
  return counts;
}

export function getLocalSlotStatus() {
  return {
    active: active.size,
    redis: [...active.values()].filter((lease) => lease.redis).length,
    queued: [...localQueues.values()].reduce((sum, queue) => sum + queue.size, 0),
  };
}
