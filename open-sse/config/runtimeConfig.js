// HTTP status codes
export const HTTP_STATUS = {
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  PAYMENT_REQUIRED: 402,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  NOT_ACCEPTABLE: 406,
  REQUEST_TIMEOUT: 408,
  RATE_LIMITED: 429,
  SERVER_ERROR: 500,
  BAD_GATEWAY: 502,
  SERVICE_UNAVAILABLE: 503,
  GATEWAY_TIMEOUT: 504
};

// Re-export error config (backward compat)
export { ERROR_TYPES, DEFAULT_ERROR_MESSAGES, BACKOFF_CONFIG, COOLDOWN_MS } from "./errorConfig.js";

// Cache TTLs (seconds)
export const CACHE_TTL = {
  userInfo: 300,    // 5 minutes
  modelAlias: 3600  // 1 hour
};

// Memory management config
export const MEMORY_CONFIG = {
  sessionTtlMs: 2 * 60 * 60 * 1000,
  sessionCleanupIntervalMs: 30 * 60 * 1000,
  dnsCacheTtlMs: 5 * 60 * 1000,
  proxyDispatchersMaxSize: 20,
  // Retained serialized Kiro replay payload budget, independent of entry count.
  kiroSessionMaxBytes: 32 * 1024 * 1024,
  kiroSessionMaxEntryBytes: 2 * 1024 * 1024,
};

// Parse a positive integer env override, falling back to a default.
function envMs(name, def) {
  const raw = process.env[name];
  if (raw == null || raw === "") return def;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : def;
}

function envUrl(name, def) {
  const raw = process.env[name]?.trim();
  return raw || def;
}

// SearXNG endpoint used by the unauthenticated web-search provider.
// Configure this for a separate Docker service or remote SearXNG instance.
export const SEARXNG_URL = envUrl("SEARXNG_URL", "http://localhost:8888/search");

// Upstream byte inactivity timeout, including waiting for the first body byte. Generous headroom so
// slow reasoning models aren't aborted mid-stream. Env: STREAM_STALL_TIMEOUT_MS.
export const STREAM_STALL_TIMEOUT_MS = envMs("STREAM_STALL_TIMEOUT_MS", 360 * 1000);
export const STREAM_STALL_CHECK_INTERVAL_MS = 1000;

// Time-to-first-token timeout (prompt prefill). Env: STREAM_FIRST_CHUNK_TIMEOUT_MS.
export const STREAM_FIRST_CHUNK_TIMEOUT_MS = envMs("STREAM_FIRST_CHUNK_TIMEOUT_MS", 200 * 1000);

// Fetch connect timeout: abort if upstream doesn't return response headers within this duration
export const FETCH_CONNECT_TIMEOUT_MS = envMs("FETCH_CONNECT_TIMEOUT_MS", 60 * 1000);

// Shared OAuth refresh lifetime, including headers and body consumption.
export const TOKEN_REFRESH_TIMEOUT_MS = envMs("TOKEN_REFRESH_TIMEOUT_MS", 60 * 1000);

// Hard deadline for buffering a non-streaming response body after headers arrive.
// This also bounds forced-SSE-to-JSON aggregation. Env: NON_STREAM_RESPONSE_TIMEOUT_MS.
export const NON_STREAM_RESPONSE_TIMEOUT_MS = envMs("NON_STREAM_RESPONSE_TIMEOUT_MS", 360 * 1000);

// Gemini native TTS fetch timeout: abort if Google does not return response headers in time.
export const GEMINI_NATIVE_TTS_FETCH_TIMEOUT_MS = envMs("GEMINI_NATIVE_TTS_FETCH_TIMEOUT_MS", 45 * 1000);

// Default token limits
export const DEFAULT_MAX_TOKENS = 64000;
export const DEFAULT_MIN_TOKENS = 32000;

export const TOKEN_SAVER_HEADER = "x-spring-mouse-token-saver";

// Retry config for 429 responses (legacy - kept for backward compatibility)
export const RETRY_CONFIG = {
  maxAttempts: 2,
  delayMs: 2000
};

// Default retry config by status code: { attempts, delayMs }
// Backward compat: if value is a number, treated as attempts with RETRY_CONFIG.delayMs
export const DEFAULT_RETRY_CONFIG = {
  429: { attempts: 0, delayMs: 0 },
  502: { attempts: 3, delayMs: 3000 },
  503: { attempts: 3, delayMs: 2000 },
  504: { attempts: 2, delayMs: 3000 }
};

// SSE-overload retry budget: a 200-OK stream that carries an `event: error`
// frame ("Our servers are currently overloaded", `server_is_overloaded`).
//
// This is deliberately a TIME budget rather than an attempt count. Measured on
// production, one upstream attempt on a real prompt costs 10-30s before the
// overload frame arrives (~18s average, 94s worst case) — so the old fixed 1.5s
// backoff was shorter than the attempt it was backing off from, every retry
// landed inside the same saturation window, and the overload reached the client
// after ~55s of retrying that could never have succeeded.
//
// The window is short: production shows the same account succeeding again within
// the same minute. The retries only have to outlast it, so the delay grows
// (3s → 9s → 15s, full jitter) inside a budget that stays well under the 165s
// time-to-first-token Codex clients were observed to tolerate.
//
//   budgetMs    — total wall-clock budget for the overload retry loop
//   baseDelayMs — first backoff, multiplied by `factor` on each retry
//   maxDelayMs  — ceiling for a single backoff
//   factor      — backoff multiplier
//   minRetries  — retries allowed even after the budget is spent, so a single
//                 slow attempt cannot consume the whole budget on its own
//   maxAttempts — hard cap, so a malformed config cannot loop forever
//   minSleepMs  — floor for a single backoff, so the loop can never hot-loop
//                 against an upstream that is already saturated
export const DEFAULT_OVERLOAD_RETRY = {
  budgetMs: envMs("SPRING_MOUSE_OVERLOAD_RETRY_BUDGET_MS", 90 * 1000),
  baseDelayMs: envMs("SPRING_MOUSE_OVERLOAD_RETRY_BASE_DELAY_MS", 3 * 1000),
  maxDelayMs: envMs("SPRING_MOUSE_OVERLOAD_RETRY_MAX_DELAY_MS", 15 * 1000),
  factor: 3,
  minRetries: 1,
  maxAttempts: 10,
  minSleepMs: 1000,
};

// Backoff for overload retry number `attempt` (1-based), before jitter.
// Exponential up to maxDelayMs: 3s, 9s, 15s, 15s…
export function resolveOverloadDelayMs(attempt, config = DEFAULT_OVERLOAD_RETRY) {
  const { baseDelayMs, maxDelayMs, factor } = { ...DEFAULT_OVERLOAD_RETRY, ...config };
  const raw = baseDelayMs * Math.pow(factor, Math.max(0, attempt - 1));
  return Math.min(Math.round(raw), maxDelayMs);
}

// Overlay a channel's strategy entry (settings.providerStrategies[providerId])
// onto the built-in overload-retry defaults, so an operator can tune the curve
// per channel from the dashboard without a release.
//
// Only keys the strategy actually specifies are returned, so a caller can layer
// this over its own defaults without the untouched keys silently resetting to the
// global ones. Only positive integers are honoured — a blank or malformed field
// keeps the default rather than silently disabling retries. The stored names are
// the `*Ms` forms the settings API produces from the dashboard's `*Seconds`
// inputs.
export function pickOverloadRetryOverrides(strategy = {}) {
  const positiveMs = (value) => {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  };
  const out = {};
  const budgetMs = positiveMs(strategy.overloadRetryBudgetMs);
  if (budgetMs) out.budgetMs = budgetMs;
  const baseDelayMs = positiveMs(strategy.overloadRetryBaseDelayMs);
  if (baseDelayMs) out.baseDelayMs = baseDelayMs;
  const maxDelayMs = positiveMs(strategy.overloadRetryMaxDelayMs);
  if (maxDelayMs) out.maxDelayMs = maxDelayMs;
  return out;
}

// The effective overload-retry config for one call. `executorConfig` is the
// executor's own default (used by open-sse consumers that never touch channel
// settings); the channel strategy wins where it is set.
export function resolveOverloadRetryConfig(strategy = {}, executorConfig = {}) {
  const config = { ...DEFAULT_OVERLOAD_RETRY, ...executorConfig, ...pickOverloadRetryOverrides(strategy) };
  // A base above the ceiling would make the curve non-monotonic; clamp instead.
  if (config.baseDelayMs > config.maxDelayMs) config.baseDelayMs = config.maxDelayMs;
  return config;
}

// Total overload-retry budget for ONE client request, shared across every model
// the combo tries. The per-model budget above is spent by whichever model is
// saturated first; without this cap a combo whose members all resolve to the
// same upstream (the GPT chain: 3-6 Codex models) would multiply it, turning a
// 90s retry into a 270-540s request that the client abandons long before the
// gateway answers. 150s is chosen against measured client patience: Codex
// clients were observed waiting up to 165s for a first token before giving up.
export const REQUEST_OVERLOAD_BUDGET_MS = envMs("SPRING_MOUSE_REQUEST_OVERLOAD_BUDGET_MS", 150 * 1000);

// Normalize a retry entry to { attempts, delayMs }
export function resolveRetryEntry(entry) {
  if (entry == null) return { attempts: 0, delayMs: RETRY_CONFIG.delayMs };
  if (typeof entry === "number") return { attempts: entry, delayMs: RETRY_CONFIG.delayMs };
  return {
    attempts: entry.attempts || 0,
    delayMs: entry.delayMs != null ? entry.delayMs : RETRY_CONFIG.delayMs
  };
}

// Requests containing these texts will bypass provider
export const SKIP_PATTERNS = [
  "Please write a 5-10 word title for the following conversation:"
];
