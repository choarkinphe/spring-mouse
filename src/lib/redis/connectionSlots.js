import { randomUUID } from "node:crypto";
import { routingRedis } from "./routingClient.js";

const positive = (value, fallback) => Math.max(1, Number.parseInt(value, 10) || fallback);
const bounded = (value, fallback, max) => Math.min(positive(value, fallback), max);
const DEFAULT_LIMIT = positive(process.env.SPRING_MOUSE_CONNECTION_MAX_CONCURRENCY, 16);
const LEASE_MS = Math.max(3000, positive(process.env.SPRING_MOUSE_CONNECTION_SLOT_TTL_SECONDS, 90) * 1000);
// Distinct v3 keys avoid mixing hard-capacity leases with former soft counters.
const slotKey = (id) => `spring-mouse:routing:{routing}:slots:v3:${id}`;
const providerKey = (providerId) => `spring-mouse:routing:{routing}:provider:v1:${providerId}`;
const queueKey = (providerId) => `spring-mouse:routing:{routing}:queue:v1:${providerId}`;
// Next route bundles and development reloads must share process accounting.
const state = globalThis.__smConnectionLeases ||= {
  active: new Map(), renewalTimer: null, renewing: false, queueSizes: new Map(),
};
const { active } = state;

export class RoutingQueueTimeoutError extends Error {
  constructor(providerId, timeoutMs) {
    super(`${providerId} concurrency queue timed out after ${timeoutMs}ms`);
    this.name = "RoutingQueueTimeoutError";
    this.code = "ROUTING_QUEUE_TIMEOUT";
    this.providerId = providerId;
    this.retryAfterMs = 1000;
  }
}

export function getConnectionConcurrencyLimit(connection, providerStrategy = {}) {
  return positive(connection?.providerSpecificData?.maxConcurrentStreams,
    positive(providerStrategy?.maxConcurrentStreams, DEFAULT_LIMIT));
}

/**
 * Approximate expensive long-context requests with a small integer weight so a
 * 1,400-message Codex turn cannot consume the same gate capacity as a two-turn
 * request. The caps keep a malformed giant body from creating a huge lease.
 */
export function estimateRequestWeight(body = {}, maxWeight = 8) {
  const messages = Array.isArray(body?.messages) ? body.messages.length : 0;
  const input = Array.isArray(body?.input) ? body.input.length : 0;
  const tools = Array.isArray(body?.tools) ? body.tools.length : 0;
  const promptChars = typeof body?.input === "string" ? body.input.length : 0;
  const pressure = Math.max(messages / 100, input / 100, tools / 20, promptChars / 100_000);
  return Math.min(maxWeight, Math.max(1, Math.ceil(pressure)));
}

export const RESERVE_SCRIPT = `
local clock = redis.call('TIME')
local now = tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000)
local best, bestRatio = 1, math.huge
for i, key in ipairs(KEYS) do
  redis.call('ZREMRANGEBYSCORE', key, '-inf', now)
  local count = redis.call('ZCARD', key)
  local ratio = count / tonumber(ARGV[i + 2])
  if ratio < bestRatio then best, bestRatio = i, ratio end
  -- Preserve priority / sticky preference while it has capacity.
  if ratio < 1 then best = i; break end
end
-- Soft saturation: still count overflow, choosing the least loaded account.
redis.call('ZADD', KEYS[best], now + tonumber(ARGV[2]), ARGV[1])
redis.call('PEXPIRE', KEYS[best], tonumber(ARGV[2]) * 2)
return best
`;

/**
 * Atomically admits one weighted request into the provider and one account.
 *
 * ARGV contract — the caller MUST pass exactly this order, and KEYS[1] is the
 * provider while account slot keys start at KEYS[2]:
 *   [1]=lease id  [2]=lease_ms  [3]=provider_limit  [4]=weight
 *   [5..]=per-account limits, aligned with KEYS[2..]
 * A missing lease_ms shifts every later slot and silently rejects all traffic.
 */
export const HARD_RESERVE_SCRIPT = `
local clock = redis.call('TIME')
local now = tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000)
local provider = KEYS[1]
local lease = ARGV[1]
local lease_ms = tonumber(ARGV[2])
local provider_limit = tonumber(ARGV[3])
local weight = tonumber(ARGV[4])
local expires = now + lease_ms

redis.call('ZREMRANGEBYSCORE', provider, '-inf', now)
if tonumber(redis.call('ZCARD', provider)) + weight > provider_limit then return 0 end

-- Candidates arrive with the sticky/priority account first. Preserve that
-- ordering instead of choosing globally least-loaded and defeating affinity.
for i, key in ipairs(KEYS) do
  if i > 1 then
    redis.call('ZREMRANGEBYSCORE', key, '-inf', now)
    if tonumber(redis.call('ZCARD', key)) + weight <= tonumber(ARGV[i + 3]) then
      for n = 0, weight - 1 do
        local member = lease .. '#' .. n
        redis.call('ZADD', provider, expires, member)
        redis.call('ZADD', key, expires, member)
      end
      redis.call('PEXPIRE', provider, lease_ms * 2)
      redis.call('PEXPIRE', key, lease_ms * 2)
      return i - 1
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

function localChoice(candidates) {
  const counts = new Map();
  for (const lease of active.values()) counts.set(lease.connectionId, (counts.get(lease.connectionId) || 0) + 1);
  let best = 0, ratio = Infinity;
  for (let i = 0; i < candidates.length; i++) {
    const load = (counts.get(candidates[i].id) || 0) / candidates[i].limit;
    if (load < ratio) { best = i; ratio = load; }
    if (load < 1) return i;
  }
  return best;
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

function createQueueTimeout(providerId, timeoutMs) {
  return new RoutingQueueTimeoutError(providerId, timeoutMs);
}

/** Local in-process hard gate used when Redis is unavailable. */
async function reserveLocalHard(providerId, candidates, options, weight, leaseId) {
  const providerLimit = options.providerLimit;
  const timeoutMs = options.queueTimeoutMs;
  const deadline = Date.now() + timeoutMs;
  const queueCounter = state.queueSizes;
  const queued = queueCounter.get(providerId) || 0;
  if (queued >= options.maxQueueSize) throw createQueueTimeout(providerId, timeoutMs);
  queueCounter.set(providerId, queued + 1);
  try {
    while (Date.now() < deadline) {
      const counts = localCounts(providerId);
      const account = candidates.find((candidate) =>
        (counts.accounts.get(candidate.id) || 0) + weight <= candidate.limit);
      if (counts.provider + weight <= providerLimit && account) {
        const chosenIndex = candidates.indexOf(account);
        const members = Array.from({ length: weight }, (_, n) => `${leaseId}#${n}`);
        const lease = {
          id: leaseId, connectionId: account.id, providerId, weight,
          redis: false, members, renewKeys: [], renewMembers: [],
        };
        active.set(leaseId, lease);
        return { lease, chosenIndex };
      }
      const remaining = deadline - Date.now();
      await sleepInterruptible(Math.min(100, Math.max(1, remaining)), options.signal);
    }
    throw createQueueTimeout(providerId, timeoutMs);
  } finally {
    const next = (queueCounter.get(providerId) || 1) - 1;
    if (next <= 0) queueCounter.delete(providerId);
    else queueCounter.set(providerId, next);
  }
}

/**
 * Ordered eligible candidates, one Redis round trip, unique lease.
 *
 * Without `options.providerLimit`, retain the historical soft overflow account
 * balancer. With a provider limit, wait for provider *and* account capacity;
 * requests are weighted and never overflow the configured hard caps.
 */
export async function reserveConnectionSlot(candidates, options = {}) {
  if (!candidates.length) throw new Error("No eligible accounts for reservation");
  const id = randomUUID();

  // Legacy path preserves balancing behavior for callers that have not opted
  // into a provider-wide hard cap.
  if (!Number.isFinite(options.providerLimit)) {
    const index = await routingRedis((client) => client.eval(RESERVE_SCRIPT, {
      keys: candidates.map((candidate) => slotKey(candidate.id)),
      arguments: [id, String(LEASE_MS), ...candidates.map((candidate) => String(candidate.limit))],
    }));
    const redis = Number.isInteger(index) && index >= 1 && index <= candidates.length;
    const chosen = redis ? index - 1 : localChoice(candidates);
    const lease = { id, connectionId: candidates[chosen].id, redis, renewKeys: [slotKey(candidates[chosen].id)], renewMembers: [id], weight: 1 };
    active.set(id, lease);
    armRenewal();
    return {
      connectionId: lease.connectionId,
      async release() {
        if (!active.delete(id)) return;
        if (!active.size) { clearInterval(state.renewalTimer); state.renewalTimer = null; }
        if (redis) await routingRedis((client) => client.zRem(slotKey(lease.connectionId), id));
      },
    };
  }

  const providerId = String(options.providerId || candidates[0].id || "provider");
  const weight = bounded(options.weight, 1, 8);
  const providerLimit = positive(options.providerLimit, 1);
  const timeoutMs = positive(options.queueTimeoutMs, 60_000);
  const maxQueueSize = positive(options.maxQueueSize, 50);
  const queue = queueKey(providerId);
  let redisAvailable = true;

  const queueCount = await routingRedis(async (client) => {
    await client.zRemRangeByScore(queue, "-inf", Date.now());
    const size = await client.zCard(queue);
    if (size >= maxQueueSize) return -1;
    await client.zAdd(queue, [{ score: Date.now() + timeoutMs, value: id }]);
    await client.pExpire(queue, timeoutMs * 2);
    return size;
  });
  if (queueCount === -1) throw createQueueTimeout(providerId, timeoutMs);
  if (queueCount === null || queueCount === undefined) redisAvailable = false;

  try {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      let index = null;
      if (redisAvailable) {
        const result = await routingRedis((client) => client.eval(HARD_RESERVE_SCRIPT, {
          keys: [providerKey(providerId), ...candidates.map((candidate) => slotKey(candidate.id))],
          arguments: [
            id, String(LEASE_MS), String(providerLimit), String(weight),
            ...candidates.map((candidate) => String(candidate.limit)),
          ],
        }));
        if (result === null || result === undefined) redisAvailable = false;
        else index = Number(result);
      }

      if (!redisAvailable) {
        const local = await reserveLocalHard(providerId, candidates, {
          ...options, providerLimit, queueTimeoutMs: Math.max(1, deadline - Date.now()), maxQueueSize,
        }, weight, id);
        return makeHardLease(local.lease, local.chosenIndex, candidates);
      }
      if (index >= 1 && index <= candidates.length) {
        const chosenIndex = index - 1;
        const members = Array.from({ length: weight }, (_, n) => `${id}#${n}`);
        const lease = {
          id, connectionId: candidates[chosenIndex].id, providerId, weight,
          redis: true, members,
          renewKeys: [providerKey(providerId), slotKey(candidates[chosenIndex].id)],
          renewMembers: members,
        };
        active.set(id, lease);
        armRenewal();
        return makeHardLease(lease, chosenIndex, candidates);
      }

      const remaining = deadline - Date.now();
      await sleepInterruptible(Math.min(150, Math.max(1, remaining)), options.signal);
    }
    throw createQueueTimeout(providerId, timeoutMs);
  } finally {
    if (redisAvailable) await routingRedis((client) => client.zRem(queue, id));
  }
}

function makeHardLease(lease, chosenIndex, candidates) {
  if (lease.connectionId !== candidates[chosenIndex]?.id) throw new Error("Routing slot candidate mismatch");
  armRenewal();
  return {
    connectionId: lease.connectionId,
    async release() {
      if (!active.delete(lease.id)) return;
      if (!active.size) { clearInterval(state.renewalTimer); state.renewalTimer = null; }
      if (!lease.redis) return;
      await routingRedis(async (client) => {
        await client.zRem(providerKey(lease.providerId), lease.members);
        await client.zRem(slotKey(lease.connectionId), lease.members);
      });
    },
  };
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
    queued: [...state.queueSizes.values()].reduce((sum, size) => sum + size, 0),
  };
}
