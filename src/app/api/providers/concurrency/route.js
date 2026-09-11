import { NextResponse } from "next/server";
import { getProviderConnections } from "@/models";
import { getSettings } from "@/lib/localDb";
import { getConnectionConcurrencyLimit, getConnectionSlotCounts } from "@/lib/redis/connectionSlots";
import { PROVIDERS } from "open-sse/config/providers.js";
import { MODEL_LOCK_PREFIX } from "open-sse/services/accountFallback.js";
import { listOpenBreakers } from "@/sse/services/providerBreaker.js";

export const dynamic = "force-dynamic";

// Mirrors the `accountStrategy` resolution in src/sse/services/auth.js so the
// reported ceiling is the one admission actually enforces (a provider-level
// transport default applies when the channel strategy leaves it unset).
function accountLimit(connection, providerOverride = {}) {
  const transport = PROVIDERS[connection.provider]?.transport || {};
  const accountStrategy = providerOverride.maxConcurrentStreams == null && Number.isFinite(transport.maxConcurrentStreams)
    ? { ...providerOverride, maxConcurrentStreams: transport.maxConcurrentStreams }
    : providerOverride;
  return getConnectionConcurrencyLimit(connection, accountStrategy);
}

// Channel ceiling and its switch, resolved exactly like reserveConnectionSlot()
// does in auth.js: an explicit providerMaxConcurrentStreams wins, a transport
// default backs it up, and hardConcurrencyEnabled === false disables the cap.
function channelLimit(provider, providerOverride = {}) {
  const transport = PROVIDERS[provider]?.transport || {};
  if (providerOverride.hardConcurrencyEnabled === false) return null;
  const configured = providerOverride.providerMaxConcurrentStreams ?? transport.providerMaxConcurrentStreams;
  return Number.isFinite(Number(configured)) ? Number(configured) : null;
}

// An account can be enabled and still be invisible to the router: any upstream
// failure writes a `modelLock_<model>` cooldown onto the row and auth.js drops
// locked accounts from the candidate list. Surfacing the lock (and its model)
// is what turns "我的请求没打到这个账号" into a visible reason.
function activeLocks(connection, now = Date.now()) {
  const locks = [];
  for (const [key, value] of Object.entries(connection || {})) {
    if (!key.startsWith(MODEL_LOCK_PREFIX) || !value) continue;
    const until = new Date(value).getTime();
    if (!Number.isFinite(until) || until <= now) continue;
    locks.push({
      model: key.slice(MODEL_LOCK_PREFIX.length).replace(/^_+/, "") || "全部模型",
      until: new Date(until).toISOString(),
      remainingMs: until - now,
    });
  }
  return locks.sort((a, b) => a.remainingMs - b.remainingMs);
}

// GET /api/providers/concurrency - live per-account concurrency usage.
//
// The router admits every upstream request through an in-process lease before
// it reaches a provider (see lib/redis/connectionSlots.js), so these are the
// same numbers admission itself uses rather than a separately tracked
// approximation. Kept as its own route so the channel list can poll it
// cheaply without re-reading connections, quotas and model counts every tick.
//
// Besides the raw counters it reports the two things that silently block a
// request before any account is picked: per-account model cooldowns and the
// provider/model circuit breaker. Both are real admission gates, neither was
// visible anywhere in the UI.
export async function GET() {
  try {
    const [connections, settings] = await Promise.all([getProviderConnections(), getSettings()]);
    const counts = getConnectionSlotCounts();
    const strategies = settings?.providerStrategies || {};
    const now = Date.now();

    const accounts = {};
    const channels = {};

    for (const connection of connections) {
      const providerOverride = strategies[connection.provider] || {};
      const locks = activeLocks(connection, now);

      accounts[connection.id] = {
        active: counts[connection.id] || 0,
        limit: accountLimit(connection, providerOverride),
        locks,
        blockedBy: connection.isActive === false ? "inactive" : locks.length ? "locked" : null,
      };

      const channel = channels[connection.provider] ||= {
        total: 0,
        active: 0,
        routable: 0,
        activeSlots: 0,
        slotLimit: channelLimit(connection.provider, providerOverride),
        hardConcurrency: providerOverride.hardConcurrencyEnabled == null
          ? Number.isFinite(Number(providerOverride.providerMaxConcurrentStreams ?? PROVIDERS[connection.provider]?.transport?.providerMaxConcurrentStreams))
          : providerOverride.hardConcurrencyEnabled === true,
        breakerEnabled: providerOverride.enableModelBreaker !== false,
        breaker: null,
      };
      channel.total += 1;
      if (connection.isActive !== false) channel.active += 1;
      channel.activeSlots += counts[connection.id] || 0;
      if (connection.isActive !== false && locks.length === 0) channel.routable += 1;
      channel.locks ||= [];
      if (locks.length) channel.locks.push({ id: connection.id, locks });
    }

    // An open breaker is channel-level state, not a per-account one. Listing the
    // breakers this process holds open is both cheaper and more accurate than
    // inferring the model from a cooldown key, which misses a breaker that
    // outlives the lock (a successful request clears the lock, never the breaker).
    for (const breaker of listOpenBreakers(now)) {
      const channel = channels[breaker.providerId];
      if (!channel) continue;
      const nearer = !channel.breaker || breaker.retryAfterMs > channel.breaker.retryAfterMs;
      if (nearer) channel.breaker = { model: breaker.model, retryAfterMs: breaker.retryAfterMs };
    }
    for (const channel of Object.values(channels)) delete channel.locks;

    return NextResponse.json({ accounts, channels }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.log("Error reading connection concurrency:", error);
    return NextResponse.json({ error: "Failed to read connection concurrency" }, { status: 500 });
  }
}
