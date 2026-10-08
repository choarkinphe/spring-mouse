// Observation only: these headers identify a compaction request, not a request
// AFTER compaction. Never copy their values into logs or change routing policy.
export const COMPACTION_REQUEST_HEADERS = [
  "x-cc-compaction-request",
  "x-claude-code-compaction",
];
export const COMPACTION_DIAGNOSTICS_LIMITS = Object.freeze({
  maxItems: 10000,
  maxBlocks: 20000,
  maxErrorChars: 16000,
});
export const COMPACTION_ERROR_CODES = new Set([
  "model_param_invalid", "invalid_request_error", "context_length_exceeded",
  "rate_limit_error", "authentication_error", "permission_error", "server_error",
  "400003", "AbortError", "TimeoutError",
]);
