const STAGES = new Set([
  "rate-limit", "parse-body", "settings", "verify-password", "record-success",
  "local-policy", "cookie-store", "mfa-cookie", "clear-mfa-cookie", "auth-cookie",
  "record-failure", "response",
]);
const NAMES = new Set([
  "Error", "TypeError", "ReferenceError", "SyntaxError", "RangeError",
  "DOMException", "TimeoutError", "AbortError", "SqliteError",
]);
const CODES = new Set([
  "SQLITE_BUSY", "SQLITE_LOCKED", "SQLITE_CANTOPEN", "SQLITE_READONLY",
  "SQLITE_IOERR", "SQLITE_CORRUPT", "SQLITE_ERROR", "ERR_SQLITE_ERROR",
  "ENOENT", "EACCES", "EPERM", "ENOSPC", "ECONNREFUSED", "ECONNRESET",
  "ETIMEDOUT", "ERR_CRYPTO_INVALID_KEYLEN", "ERR_INVALID_ARG_TYPE",
]);
const CATEGORIES = new Set([
  "sqlite-busy", "sqlite-locked", "sqlite-error", "filesystem", "network",
  "request-json", "cookie-context", "crypto", "type-error", "unknown",
]);
const ERROR_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

// Only fixed labels leave this boundary. Messages, stacks and nested causes may
// contain submitted passwords, cookies, SQL values or signing material.
export function classifyLoginError(error, stage) {
  const name = NAMES.has(error?.name) ? error.name : "unknown";
  const code = CODES.has(error?.code) ? error.code : "unknown";
  const message = typeof error?.message === "string" ? error.message : "";
  const sqliteCode = code === "ERR_SQLITE_ERROR" && Number.isInteger(error?.errcode)
    ? error.errcode & 0xff : null;
  let category = "unknown";
  if (code === "SQLITE_BUSY" || sqliteCode === 5 || message === "database is busy") category = "sqlite-busy";
  else if (code === "SQLITE_LOCKED" || sqliteCode === 6 || message === "database table is locked") category = "sqlite-locked";
  else if (code.startsWith("SQLITE_") || code === "ERR_SQLITE_ERROR" || message === "database is locked") category = "sqlite-error";
  else if (["ENOENT", "EACCES", "EPERM", "ENOSPC"].includes(code)) category = "filesystem";
  else if (["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT"].includes(code)) category = "network";
  else if (stage === "parse-body" && name === "SyntaxError") category = "request-json";
  else if (message === "Cookies can only be modified in a Server Action or Route Handler. Read more: https://nextjs.org/docs/app/api-reference/functions/cookies#options") category = "cookie-context";
  else if (code === "ERR_CRYPTO_INVALID_KEYLEN") category = "crypto";
  else if (name === "TypeError") category = "type-error";
  return { name, code, category };
}

export function sanitizeLoginDiagnostic(value) {
  return {
    event: "auth.login.failure",
    errorId: typeof value?.errorId === "string" && ERROR_ID.test(value.errorId) ? value.errorId : "unavailable",
    stage: STAGES.has(value?.stage) ? value.stage : "unknown",
    name: NAMES.has(value?.name) ? value.name : "unknown",
    code: CODES.has(value?.code) ? value.code : "unknown",
    category: CATEGORIES.has(value?.category) ? value.category : "unknown",
  };
}
