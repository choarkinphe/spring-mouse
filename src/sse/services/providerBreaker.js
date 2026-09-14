import { createHash } from "node:crypto";
import { routingRedis } from "@/lib/redis/routingClient.js";

const positive = (value, fallback) => Math.max(1, Number.parseInt(value, 10) || fallback);
const FAILURE_WINDOW_MS = positive(process.env.SPRING_MOUSE_PROVIDER_BREAKER_WINDOW_MS, 120_000);
const COOLDOWN_MS = positive(process.env.SPRING_MOUSE_PROVIDER_BREAKER_COOLDOWN_MS, 60_000);
const THRESHOLD = positive(process.env.SPRING_MOUSE_PROVIDER_BREAKER_THRESHOLD, 3);

// Model-level capacity/overload signals get their own, much gentler throttle.
// The account breaker exists to stop hammering a *broken* upstream for a minute;
// an overloaded model is not broken, it is busy, and a 60s whole-model outage is
// a wildly disproportionate response to a few seconds of upstream back-pressure.
// Six signals inside the window earn a five second breather instead.
const OVERLOAD_THRESHOLD = positive(process.env.SPRING_MOUSE_OVERLOAD_THRESHOLD, 6);
const OVERLOAD_COOLDOWN_MS = positive(process.env.SPRING_MOUSE_OVERLOAD_COOLDOWN_MS, 5_000);

const g = globalThis.__smProviderBreakers ||= { providers: new Map(), overloads: new Map() };
// Reloads / route bundles created before this change may lack the second map.
g.overloads ||= new Map();

function keyParts(providerId, model, scope = "breaker") {
  const digest = createHash("sha256").update(`${providerId}\n${model || ""}`).digest("hex").slice(0, 32);
  return {
    failures: `spring-mouse:routing:{routing}:${scope}:v1:${digest}:failures`,
    open: `spring-mouse:routing:{routing}:${scope}:v1:${digest}:open`,
  };
}

function positiveOption(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readLocal(store, providerId, model, now = Date.now()) {
  const key = `${providerId}\n${model || ""}`;
  const state = store.get(key);
  if (!state) return { open: false };
  if (state.openUntil > now) return { open: true, retryAfterMs: state.openUntil - now };
  if (state.openUntil && state.openUntil <= now) store.delete(key);
  return { open: false };
}

/** Check the shared breaker without making availability depend on Redis. */
export async function getProviderModelBreaker(providerId, model, strategy = {}) {
  if (!providerId || !model || strategy.enableModelBreaker === false) return { open: false };
  const local = readLocal(g.providers, providerId, model);
  if (local.open) return local;

  const keys = keyParts(providerId, model);
  const raw = await routingRedis((client) => client.get(keys.open));
  if (!raw) return local;
  let payload = {};
  try { payload = JSON.parse(raw); } catch { payload = {}; }
  const ttlMs = await routingRedis((client) => client.pTTL(keys.open));
  const cooldownMs = positiveOption(strategy.breakerCooldownMs, COOLDOWN_MS);
  const retryAfterMs = Number.isFinite(ttlMs) && ttlMs >= 0 ? ttlMs : cooldownMs;
  return { open: true, retryAfterMs, until: payload.until || null };
}

/**
 * Read the model-level overload throttle. Kept separate from the account breaker
 * so an overloaded model can be slowed down without quarantining accounts or
 * tripping the long provider outage breaker.
 */
export async function getModelOverloadThrottle(providerId, model, strategy = {}) {
  if (!providerId || !model || strategy.enableModelBreaker === false) return { open: false };
  const local = readLocal(g.overloads, providerId, model);
  if (local.open) return local;

  const keys = keyParts(providerId, model, "overload");
  const raw = await routingRedis((client) => client.get(keys.open));
  if (!raw) return local;
  const ttlMs = await routingRedis((client) => client.pTTL(keys.open));
  const cooldownMs = positiveOption(strategy.overloadCooldownMs, OVERLOAD_COOLDOWN_MS);
  return { open: true, retryAfterMs: Number.isFinite(ttlMs) && ttlMs >= 0 ? ttlMs : cooldownMs };
}

/**
 * Count consecutive routable upstream failures. Once the threshold is reached,
 * stop scanning every account and cool the provider/model pair down together.
 *
 * `options.modelLevel` routes the failure into the overload throttle instead:
 * the account breaker is deliberately not touched, because no account is at
 * fault and blocking the whole model for a minute is the behaviour that made a
 * short upstream hiccup look like a total outage.
 */
export async function recordProviderModelFailure(providerId, model, strategy = {}, options = {}) {
  if (!providerId || !model || strategy.enableModelBreaker === false) return { open: false };
  const modelLevel = options.modelLevel === true;
  const scope = modelLevel ? "overload" : "breaker";
  const store = modelLevel ? g.overloads : g.providers;
  const threshold = modelLevel
    ? positiveOption(strategy.overloadThreshold, OVERLOAD_THRESHOLD)
    : positiveOption(strategy.breakerThreshold, THRESHOLD);
  const failureWindowMs = positiveOption(strategy.breakerWindowMs, FAILURE_WINDOW_MS);
  const cooldownMs = modelLevel
    ? positiveOption(strategy.overloadCooldownMs, OVERLOAD_COOLDOWN_MS)
    : positiveOption(strategy.breakerCooldownMs, COOLDOWN_MS);
  const now = Date.now();
  const localKey = `${providerId}\n${model}`;
  const local = store.get(localKey) || { count: 0, windowStartedAt: now, openUntil: 0 };
  if (now - local.windowStartedAt > failureWindowMs) {
    local.count = 0;
    local.windowStartedAt = now;
  }
  local.count += 1;
  if (local.count >= threshold) {
    local.openUntil = now + cooldownMs;
    local.count = 0;
  }
  store.set(localKey, local);

  const keys = keyParts(providerId, model, scope);
  const opened = await routingRedis((client) => client.eval(`
    local failures = KEYS[1]
    local open = KEYS[2]
    local count = redis.call('INCR', failures)
    redis.call('PEXPIRE', failures, tonumber(ARGV[1]))
    if count < tonumber(ARGV[2]) then return 0 end
    redis.call('DEL', failures)
    redis.call('SET', open, '{"until":' .. tostring(now_ms()) .. '}', 'EX', math.ceil(tonumber(ARGV[3]) / 1000))
    return 1
  `.replace("now_ms()", `${now}`), {
    keys: [keys.failures, keys.open],
    arguments: [String(failureWindowMs), String(threshold), String(cooldownMs)],
  }));
  const sharedOpen = opened === 1;
  if (sharedOpen && local.openUntil <= now) local.openUntil = now + cooldownMs;
  if (!sharedOpen && local.openUntil <= now) return { open: false };
  return { open: true, retryAfterMs: cooldownMs, modelLevel };
}

/**
 * Enumerate the breakers this process currently has open. Every open — local or
 * shared via Redis — also stamps the in-process `openUntil`, so listing memory
 * is enough for the dashboard and avoids fanning out one lookup per model.
 */
export function listOpenBreakers(now = Date.now()) {
  const open = [];
  for (const [key, state] of g.providers.entries()) {
    if (!state?.openUntil || state.openUntil <= now) continue;
    const separator = key.indexOf("\n");
    open.push({
      providerId: separator === -1 ? key : key.slice(0, separator),
      model: separator === -1 ? "" : key.slice(separator + 1),
      retryAfterMs: state.openUntil - now,
    });
  }
  return open;
}

export async function clearProviderModelBreaker(providerId, model) {
  if (!providerId || !model) return;
  g.providers.delete(`${providerId}\n${model}`);
  const keys = keyParts(providerId, model);
  await routingRedis((client) => client.del([keys.failures, keys.open]));
}
