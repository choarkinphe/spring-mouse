import { randomUUID } from "node:crypto";
import { routingRedis } from "./routingClient.js";

const positive = (value, fallback) => Math.max(1, Number.parseInt(value, 10) || fallback);
const DEFAULT_LIMIT = positive(process.env.SPRING_MOUSE_CONNECTION_MAX_CONCURRENCY, 16);
const LEASE_MS = Math.max(3000, positive(process.env.SPRING_MOUSE_CONNECTION_SLOT_TTL_SECONDS, 90) * 1000);
// Distinct v2 keys avoid mixing lease sorted sets with the former integer counters.
const slotKey = (id) => `spring-mouse:routing:{slots}:v2:${id}`;
// Next route bundles and development reloads must share process accounting.
const state = globalThis.__smConnectionLeases ||= { active: new Map(), renewalTimer: null, renewing: false };
const { active } = state;

export function getConnectionConcurrencyLimit(connection, providerStrategy = {}) {
  return positive(connection?.providerSpecificData?.maxConcurrentStreams,
    positive(providerStrategy?.maxConcurrentStreams, DEFAULT_LIMIT));
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
    const leases = [...active.values()].filter((lease) => lease.redis);
    if (!leases.length) return;
    state.renewing = true;
    try {
      await routingRedis((client) => client.eval(RENEW_SCRIPT, {
        keys: leases.map((lease) => slotKey(lease.connectionId)),
        arguments: [String(LEASE_MS), ...leases.map((lease) => lease.id)],
      }));
    } finally { state.renewing = false; }
  }, Math.floor(LEASE_MS / 3));
  state.renewalTimer.unref?.();
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

/** Ordered eligible candidates, one Redis round trip, unique idempotent lease. */
export async function reserveConnectionSlot(candidates) {
  if (!candidates.length) throw new Error("No eligible accounts for reservation");
  const id = randomUUID();
  const index = await routingRedis((client) => client.eval(RESERVE_SCRIPT, {
    keys: candidates.map((candidate) => slotKey(candidate.id)),
    arguments: [id, String(LEASE_MS), ...candidates.map((candidate) => String(candidate.limit))],
  }));
  const redis = Number.isInteger(index) && index >= 1 && index <= candidates.length;
  const chosen = redis ? index - 1 : localChoice(candidates);
  const lease = { id, connectionId: candidates[chosen].id, redis };
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

export function getLocalSlotStatus() {
  return { active: active.size, redis: [...active.values()].filter((lease) => lease.redis).length };
}
