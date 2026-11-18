// Usage history outlives request details. Never copy upstream text into it:
// even a short error message can contain a prompt, token or signed URL.
// Recognize a limited set of diagnostic signals and save only our own labels.
const MAX_INSPECTED_CHARS = 4096;
const GENERIC_FAILURE = "Request failed; see the request detail or gateway logs for diagnostics";

const KNOWN_FAILURES = [
  [/claude code.{0,50}(?:does not support|version.{0,30}required|or newer)/i, "Upstream rejected the Claude Code version"],
  [/empty_stream/, "Stream ended without any model output (empty_stream)"],
  [/stream ended .*\(incomplete\)/, "Upstream stream ended before its terminal event"],
  // Stall codes come from utils/streamHandler.js. Ordered before the generic
  // timeout rule so a mid-answer stall is not reported as a request timeout.
  [/UPSTREAM_VISIBLE_STALL:upstream_active_client_silent/, "Upstream kept sending but nothing reached the client (stalled)"],
  [/UPSTREAM_VISIBLE_STALL|client output stalled/, "Upstream stopped mid-answer and the stream stalled"],
  [/UPSTREAM_STALL|stream stall timeout/, "Upstream stream went silent and was stopped"],
  [/stream failed \(stream_error|\(stream_error\)/i, "Upstream stream failed mid-answer"],
  [/invalid (?:sse|json) response/i, "Upstream response could not be decoded"],
  [/no active credentials for provider/i, "No active upstream account is configured"],
  [/all accounts unavailable/i, "All upstream accounts are unavailable"],
  [/timed out|timeout/i, "Request timed out"],
  [/concurrency limit/i, "Configured concurrency limit reached"],
  [/invalid.*(?:api[ _-]?key|token)|authentication|unauthorized/i, "Upstream rejected authentication"],
  [/overload|temporarily unavailable/i, "Upstream service overloaded or unavailable"],
  [/rate[ _-]?limit|too many requests/i, "Request rate limit reached"],
  [/quota|credits? exhausted/i, "Usage quota exhausted"],
  [/fetch failed|connection reset|socket hang up/i, "Upstream connection failed"],
];

export const API_KEY_REJECTIONS = Object.freeze({
  QUOTA: "api_key_quota",
  RATE_LIMIT: "api_key_rate_limit",
});

const POLICY_FAILURES = new Map([
  [`blocked:${API_KEY_REJECTIONS.QUOTA}`, "API key token quota exhausted"],
  [`blocked:${API_KEY_REJECTIONS.RATE_LIMIT}`, "API key request rate limit reached"],
]);
const SAFE_LABELS = new Set([GENERIC_FAILURE, ...KNOWN_FAILURES.map(([, label]) => label)]);
const NO_ERROR_STATUSES = new Set(["success", "ok", "cancelled", "error:499"]);

export function isApiKeyRejectionStatus(status) {
  return POLICY_FAILURES.has(status);
}

// Older or imported rows may not have passed through the current write path.
export function readUsageError(value, status) {
  if (NO_ERROR_STATUSES.has(status)) return null;
  return POLICY_FAILURES.get(status) ?? (SAFE_LABELS.has(value) ? value : null);
}

export function summarizeUsageError(value, status) {
  if (NO_ERROR_STATUSES.has(status)) return null;
  const policy = POLICY_FAILURES.get(status);
  if (policy) return policy;
  // Callers provide a message, raw HTTP error body, or Error. The inspected
  // prefix is never returned, including when no known signal is found.
  const text = typeof value === "string" ? value : value?.message || value?.error?.message;
  if (typeof text !== "string" || !text) return null;
  const prefix = text.slice(0, MAX_INSPECTED_CHARS);
  if (!prefix.trim()) return null;
  return KNOWN_FAILURES.find(([pattern]) => pattern.test(prefix))?.[1] || GENERIC_FAILURE;
}
