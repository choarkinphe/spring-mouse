import crypto from "node:crypto";
import pkg from "../../package.json" with { type: "json" };

const SESSION_HEADERS = [
  "x-opencode-session",
  "x-session-id",
  "session-id",
  "session_id",
  "x-amp-thread-id",
];
const GENERIC_USER_AGENTS = /^(?:node|undici|axios|fetch|got|curl|python-requests|requests|openai-(?:python|node)|anthropic(?:-(?:python|node))?)(?:\/|$)/i;
const SPRING_MOUSE_USER_AGENT = `Spring-Mouse/${pkg.version || "0.0.0"}`;

function normalizedString(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized && normalized.length <= 1024 && !/[\x00-\x1f\x7f]/.test(normalized) ? normalized : null;
}

function getHeader(headers, name) {
  if (!headers || typeof headers !== "object") return null;
  if (typeof headers.get === "function") return normalizedString(headers.get(name));
  const key = Object.keys(headers).find(candidate => candidate.toLowerCase() === name);
  return key ? normalizedString(headers[key]) : null;
}

function conversationId(headers, body) {
  for (const name of SESSION_HEADERS) {
    const value = getHeader(headers, name);
    if (value) return value;
  }

  // These body fields are intended to survive across turns. Do not use request
  // IDs, user IDs, prompt text, or account/connection IDs as session identity.
  const bodyId = normalizedString(body?.session_id)
    || normalizedString(body?.conversation_id);
  if (bodyId) return bodyId;

  // Claude Code's structured user_id embeds a conversation session ID; avoid
  // forwarding the full metadata value (which may contain unrelated identity).
  const userId = body?.metadata?.user_id;
  if (typeof userId === "string") {
    const match = userId.match(/_session_([a-f0-9-]{16,})$/i);
    if (match) return `claude:${match[1]}`;
    if (userId.startsWith("{")) {
      try {
        const sessionId = normalizedString(JSON.parse(userId)?.session_id);
        if (sessionId) return `claude:${sessionId}`;
      } catch { /* malformed metadata is not a session identity */ }
    }
  }
  return null;
}

/**
 * Build only the client identity headers required by OpenCode Go.
 * Native session IDs are preserved; explicit body conversation IDs are hashed
 * before forwarding so opaque third-party IDs are not exposed upstream.
 */
export function buildOpenCodeGoHeaders({ headers = {}, body = {}, sessionId = null } = {}) {
  const rawUserAgent = getHeader(headers, "user-agent");
  const userAgent = rawUserAgent && !GENERIC_USER_AGENTS.test(rawUserAgent)
    ? rawUserAgent
    : SPRING_MOUSE_USER_AGENT;
  const resolvedSessionId = normalizedString(sessionId) || conversationId(headers, body);

  return {
    "User-Agent": userAgent,
    ...(resolvedSessionId ? {
      "x-opencode-session": getHeader(headers, "x-opencode-session")
        ? resolvedSessionId
        : `sm_${crypto.createHash("sha256").update(resolvedSessionId).digest("hex")}`,
    } : {}),
  };
}
