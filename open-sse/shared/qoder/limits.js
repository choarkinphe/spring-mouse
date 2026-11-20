import { BACKOFF_CONFIG, QODER_LIMITS } from "../../config/errorConfig.js";

// Qoder sometimes JSON-encodes the queue payload in message, and may wrap
// that business error in another 403 object. Bound parsing of untrusted input.
export function qoderErrorLayers(input) {
  const layers = [];
  const pending = [input];
  for (let i = 0; i < pending.length && i < 8; i++) {
    let item = pending[i];
    if (typeof item === "string") {
      try { item = JSON.parse(item); } catch { continue; }
    }
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    layers.push(item);
    for (const key of ["error", "message", "body"]) {
      const next = item[key];
      if (pending.length < 8 && (typeof next === "object" && next !== null
        || typeof next === "string" && next.trimStart().startsWith("{"))) pending.push(next);
    }
  }
  return layers;
}

// Qoder uses both numeric and string business codes.
export function isQoderLimitCode(code) {
  return QODER_LIMITS.codes.has(Number(code));
}

// Match structured business codes only; message text is not a business code.
export function classifyQoderLimit(provider, body) {
  if (!QODER_LIMITS.providers.has(provider)) return null;
  const layers = qoderErrorLayers(body);
  const has = (code) => layers.some(item => Number(item.code) === code);
  if (has(QODER_LIMITS.queueCode)) return { kind: "queue" };
  if (has(QODER_LIMITS.dailyCountCode)) return { kind: "dailyCount" };
  if (has(QODER_LIMITS.quotaCode)) return { kind: "quota" };
  return null;
}

// Cooldown for the limits whose upstream hint cannot be taken at face value.
// Returns null for everything else, which keeps the shared fallback policy.
export function qoderLimitCooldown(limit, { retryAfterMs = 0, backoffLevel = 0, lockedUntilMs = 0, now = Date.now() } = {}) {
  if (limit?.kind === "dailyCount") return { cooldownMs: QODER_LIMITS.dailyCountCooldownMs };
  if (limit?.kind !== "queue") return null;
  // Requests already in flight when the lock was written failed in the same
  // wave. They are one recovery round, not N consecutive retries.
  if (lockedUntilMs > now) return { cooldownMs: lockedUntilMs - now, newBackoffLevel: backoffLevel };
  const level = Math.min(Math.max(0, backoffLevel), BACKOFF_CONFIG.maxLevel);
  const base = retryAfterMs > 0 ? retryAfterMs : QODER_LIMITS.queueBaseCooldownMs;
  return {
    cooldownMs: Math.min(QODER_LIMITS.queueMaxCooldownMs, base * 2 ** level),
    newBackoffLevel: Math.min(level + 1, BACKOFF_CONFIG.maxLevel),
  };
}
