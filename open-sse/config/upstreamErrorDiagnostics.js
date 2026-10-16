import { SSE_ERROR_ORIGINS } from "./errorConfig.js";

export const UPSTREAM_DIAGNOSTIC_LIMITS = Object.freeze({ maxChars: 16000, maxCode: 1e9 });
export const UPSTREAM_DIAGNOSTIC_CODES = new Set([
  "error", "api_error", "server_error", "internal_server_error", "overloaded_error",
  "rate_limit_error", "rate_limit_exceeded", "insufficient_quota", "usage_limit_reached",
  "authentication_error", "permission_error", "invalid_request_error",
  "context_length_exceeded", "model_not_found", "model_param_invalid",
]);
export const UPSTREAM_DIAGNOSTIC_ORIGINS = new Set(Object.values(SSE_ERROR_ORIGINS));
export const UPSTREAM_FAILURE_KINDS = Object.freeze({
  ERROR: "upstream_error", EMPTY: "empty_output", LIMIT: "admission_limit",
});
export const UPSTREAM_DIAGNOSTIC_KINDS = new Set(Object.values(UPSTREAM_FAILURE_KINDS));
