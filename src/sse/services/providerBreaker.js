import { createHash } from "node:crypto";
import { routingRedis } from "@/lib/redis/routingClient.js";

const positive = (value, fallback) => Math.max(1, Number.parseInt(value, 10) || fallback);
const FAILURE_WINDOW_MS = positive(process.env.SPRING_MOUSE_PROVIDER_BREAKER_WINDOW_MS, 120_000);
const COOLDOWN_MS = positive(process.env.SPRING_MOUSE_PROVIDER_BREAKER_COOLDOWN_MS, 60_000);
const THRESHOLD = positive(process.env.SPRING_MOUSE_PROVIDER_BREAKER_THRESHOLD, 3);

const g = globalThis.__smProviderBreakers ||= { providers: new Map() };

function keyParts(providerId, model) {
  const digest = createHash("sha256").update(`${providerId}\n${model || ""}`).digest("hex").slice(0, 32);
  return {
    failures: `spring-mouse:routing:{routing}:breaker:v1:${digest}:failures`,
    open: `spring-mouse:routing:{routing}:breaker:v1:${digest}:open`,
  };
}

function positiveOption(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readLocal(providerId, model, now = Date.now()) {
  const key = `${providerId}\n${model || ""}`;
  const state = g.providers.get(key);
  if (!state) return { open: false };
  if (state.openUntil > now) return { open: true, retryAfterMs: state.openUntil - now };
  if (state.openUntil && state.openUntil <= now) g.providers.delete(key);
  return { open: false };
}

/** Check the shared breaker without making availability depend on Redis. */
export async function getProviderModelBreaker(providerId, model, strategy = {}) {
  if (!providerId || !model || strategy.enableModelBreaker === false) return { open: false };
  const local = readLocal(providerId, model);
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
 * Count consecutive routable upstream failures. Once the threshold is reached,
 * stop scanning every account and cool the provider/model pair down together.
 */
export async function recordProviderModelFailure(providerId, model, strategy = {}) {
  if (!providerId || !model || strategy.enableModelBreaker === false) return { open: false };
  const threshold = positiveOption(strategy.breakerThreshold, THRESHOLD);
  const failureWindowMs = positiveOption(strategy.breakerWindowMs, FAILURE_WINDOW_MS);
  const cooldownMs = positiveOption(strategy.breakerCooldownMs, COOLDOWN_MS);
  const now = Date.now();
  const localKey = `${providerId}\n${model}`;
  const local = g.providers.get(localKey) || { count: 0, windowStartedAt: now, openUntil: 0 };
  if (now - local.windowStartedAt > failureWindowMs) {
    local.count = 0;
    local.windowStartedAt = now;
  }
  local.count += 1;
  if (local.count >= threshold) {
    local.openUntil = now + cooldownMs;
    local.count = 0;
  }
  g.providers.set(localKey, local);

  const keys = keyParts(providerId, model);
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
  return { open: true, retryAfterMs: cooldownMs };
}

export async function clearProviderModelBreaker(providerId, model) {
  if (!providerId || !model) return;
  g.providers.delete(`${providerId}\n${model}`);
  const keys = keyParts(providerId, model);
  await routingRedis((client) => client.del([keys.failures, keys.open]));
}
