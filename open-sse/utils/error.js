import { ERROR_TYPES, DEFAULT_ERROR_MESSAGES, MAX_RATE_LIMIT_COOLDOWN_MS } from "../config/errorConfig.js";
import { UPSTREAM_DIAGNOSTIC_CODES as DIAGNOSTIC_CODES, UPSTREAM_DIAGNOSTIC_ORIGINS as DIAGNOSTIC_ORIGINS, UPSTREAM_DIAGNOSTIC_KINDS as DIAGNOSTIC_KINDS, UPSTREAM_DIAGNOSTIC_LIMITS as DIAGNOSTIC_LIMITS } from "../config/upstreamErrorDiagnostics.js";
import { HTTP_STATUS } from "../config/runtimeConfig.js";

// SSE failures can arrive over HTTP 200. That transport status must never
// become the HTTP status of a JSON error, including legacy persisted cooldowns.
export function normalizeErrorStatus(statusCode, fallback = HTTP_STATUS.BAD_GATEWAY) {
  const status = Number(statusCode);
  return Number.isInteger(status) && status >= 400 && status <= 599 ? status : fallback;
}

/**
 * Build OpenAI-compatible error response body
 * @param {number} statusCode - HTTP status code
 * @param {string} message - Error message
 * @returns {object} Error response object
 */
export function buildErrorBody(statusCode, message) {
  const errorInfo = ERROR_TYPES[statusCode] || 
    (statusCode >= 500 
      ? { type: "server_error", code: "internal_server_error" }
      : { type: "invalid_request_error", code: "" });

  return {
    error: {
      message: message || DEFAULT_ERROR_MESSAGES[statusCode] || "An error occurred",
      type: errorInfo.type,
      code: errorInfo.code
    }
  };
}

/**
 * Create error Response object (for non-streaming)
 * @param {number} statusCode - HTTP status code
 * @param {string} message - Error message
 * @returns {Response} HTTP Response object
 */
export function errorResponse(statusCode, message) {
  statusCode = normalizeErrorStatus(statusCode);
  return new Response(JSON.stringify(buildErrorBody(statusCode, message)), {
    status: statusCode,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*"
    }
  });
}

/**
 * Write error to SSE stream (for streaming)
 * @param {WritableStreamDefaultWriter} writer - Stream writer
 * @param {number} statusCode - HTTP status code
 * @param {string} message - Error message
 */
export async function writeStreamError(writer, statusCode, message) {
  const errorBody = buildErrorBody(statusCode, message);
  const encoder = new TextEncoder();
  await writer.write(encoder.encode(`data: ${JSON.stringify(errorBody)}\n\n`));
}

/**
 * Parse upstream provider error response
 * @param {Response} response - Fetch response from provider
 * @param {object} [executor] - Optional executor with parseError() override for provider-specific parsing
 * @returns {Promise<{statusCode: number, message: string, resetsAtMs?: number}>}
 */
function retryAfterMs(response) {
  const value = response?.headers?.get?.("retry-after");
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 30 * 60 * 1000);
  const dateMs = new Date(value).getTime();
  return Number.isFinite(dateMs) ? Math.max(0, Math.min(dateMs - Date.now(), 30 * 60 * 1000)) : null;
}

function classifyErrorLayer(bodyText = "", message = "") {
  const text = `${message}\n${bodyText}`.toLowerCase();
  if (/spring\s*(mouse|rejected)|spring rejected|\bnext\.js\b|\bfastapi\b/.test(text)) return "gateway";
  if (/econnreset|etimedout|enotfound|fetch failed|socket|network/.test(text)) return "network";
  return "provider";
}

const diagnosticCode = (value) => Number.isSafeInteger(value) && Math.abs(value) <= DIAGNOSTIC_LIMITS.maxCode
  ? value : DIAGNOSTIC_CODES.has(value) ? value : value == null ? null : "other";

// Classify fresh errors at ingestion. Monitoring never needs to read stored
// raw payloads. Unknown strings (including messages, IDs and tokens) are dropped.
export function upstreamErrorDiagnostics(bodyText, { origin, failureKind } = {}) {
  const diagnostics = {
    version: 1, parsed: false, oversized: false,
    origin: DIAGNOSTIC_ORIGINS.has(origin) ? origin : null,
    kind: DIAGNOSTIC_KINDS.has(failureKind) ? failureKind : null,
    code: null, type: null, nestedCode: null, baseCode: null,
  };
  if (typeof bodyText !== "string" || !bodyText) return diagnostics;
  if (bodyText.length > DIAGNOSTIC_LIMITS.maxChars) return { ...diagnostics, oversized: true };
  try {
    const payload = JSON.parse(bodyText);
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return diagnostics;
    return { ...diagnostics, parsed: true,
      code: diagnosticCode(payload.code),
      type: diagnosticCode(payload.error?.type ?? payload.type),
      nestedCode: diagnosticCode(payload.error?.code ?? payload.extError?.code),
      baseCode: diagnosticCode(payload.base_resp?.status_code ?? payload.baseResp?.statusCode),
    };
  } catch { return diagnostics; }
}

export function buildUpstreamError(response, bodyText, message, source = "http", overrides = {}) {
  return {
    source,
    status: response?.status,
    message: String(message || "").slice(0, 2000),
    body: String(bodyText || "").slice(0, 4000),
    retryAfterMs: retryAfterMs(response),
    receivedAt: new Date().toISOString(),
    layer: classifyErrorLayer(bodyText, message),
    ...overrides,
    diagnostics: upstreamErrorDiagnostics(bodyText, overrides),
  };
}

export async function parseUpstreamError(response, executor = null) {
  let bodyText = "";
  try {
    bodyText = await response.text();
  } catch {
    bodyText = "";
  }

  const fallback = () => {
    let message = "";
    try {
      const json = JSON.parse(bodyText);
      message = json.error?.message || json.message || json.error || bodyText;
    } catch {
      message = bodyText;
    }
    const messageStr = typeof message === "string" ? message : JSON.stringify(message);
    const finalMessage = messageStr || DEFAULT_ERROR_MESSAGES[response.status] || `Upstream error: ${response.status}`;
    return { statusCode: response.status, message: finalMessage, upstreamError: buildUpstreamError(response, bodyText, finalMessage) };
  };

  // Let executor-specific parser extract provider-specific fields (e.g. codex resetsAtMs)
  if (executor && typeof executor.parseError === "function") {
    try {
      const parsed = executor.parseError(response, bodyText);
      if (parsed && typeof parsed === "object") {
        const msg = parsed.message || DEFAULT_ERROR_MESSAGES[response.status] || `Upstream error: ${response.status}`;
        const upstreamError = buildUpstreamError(response, bodyText, msg, "http", {
          status: parsed.status || response.status,
        });
        // Provider JSON may carry a retry hint when the HTTP header is absent.
        // Never shorten an explicit Retry-After header using a body hint.
        if (Number.isFinite(parsed.retryAfterMs) && parsed.retryAfterMs > 0) {
          upstreamError.retryAfterMs = Math.min(
            Math.max(upstreamError.retryAfterMs || 0, parsed.retryAfterMs),
            MAX_RATE_LIMIT_COOLDOWN_MS,
          );
        }
        return {
          statusCode: parsed.status || response.status,
          message: msg,
          resetsAtMs: parsed.resetsAtMs,
          upstreamError,
        };
      }
    } catch { /* fall through to default parsing */ }
  }
  return fallback();
}

/**
 * Create error result for chatCore handler
 * @param {number} statusCode - HTTP status code
 * @param {string} message - Error message
 * @param {number} [resetsAtMs] - Optional precise cooldown expiry (ms epoch) for provider-specific quota errors
 * @returns {{ success: false, status: number, error: string, response: Response, resetsAtMs?: number }}
 */
export function createErrorResult(statusCode, message, resetsAtMs, upstreamError = null) {
  statusCode = normalizeErrorStatus(statusCode);
  return {
    success: false,
    status: statusCode,
    error: message,
    resetsAtMs,
    upstreamError,
    response: errorResponse(statusCode, message)
  };
}

/**
 * Create unavailable response when all accounts are rate limited
 * @param {number} statusCode - Original error status code
 * @param {string} message - Error message (without retry info)
 * @param {string} retryAfter - ISO timestamp when earliest account becomes available
 * @param {string} retryAfterHuman - Human-readable retry info e.g. "reset after 30s"
 * @returns {Response}
 */
export function unavailableResponse(statusCode, message, retryAfter, retryAfterHuman) {
  statusCode = normalizeErrorStatus(statusCode, HTTP_STATUS.SERVICE_UNAVAILABLE);
  const retryAfterSec = Math.max(Math.ceil((new Date(retryAfter).getTime() - Date.now()) / 1000), 1);
  const msg = `${message} (${retryAfterHuman})`;
  return new Response(
    JSON.stringify(buildErrorBody(statusCode, msg)),
    {
      status: statusCode,
      headers: {
        "Content-Type": "application/json",
        "Retry-After": String(retryAfterSec)
      }
    }
  );
}

/**
 * Format provider error with context
 * @param {Error} error - Original error
 * @param {string} provider - Provider name
 * @param {string} model - Model name
 * @param {number|string} statusCode - HTTP status code or error code
 * @returns {string} Formatted error message
 */
export function formatProviderError(error, provider, model, statusCode) {
  const code = statusCode || error.code || "FETCH_FAILED";
  const message = error.message || "Unknown error";
  // Expose low-level cause (e.g. UND_ERR_SOCKET, ECONNRESET, ETIMEDOUT) for diagnosing fetch failures
  const causeCode = error.cause?.code;
  const causeMsg = error.cause?.message;
  const causeStr = causeCode || causeMsg ? ` (cause: ${[causeCode, causeMsg].filter(Boolean).join(": ")})` : "";
  return `[${code}]: ${message}${causeStr}`;
}
