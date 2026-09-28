export function isClaudeMessagesRouteRequest(url, model) {
  if (typeof model !== "string" || model.includes("/") || !/^claude-/i.test(model)) return false;
  try {
    const pathname = new URL(url).pathname.replace(/\/+$/, "");
    return pathname === "/v1/messages" || pathname === "/api/v1/messages";
  } catch {
    return false;
  }
}

export function normalizeClaudeMessagesRoute(value) {
  if (typeof value !== "string") throw new Error("claudeMessagesRoute must be a string");
  const route = value.trim();
  if (!route) return "";
  if (route.length > 200 || /[\s\p{Cc}]/u.test(route)) {
    throw new Error("claudeMessagesRoute must be at most 200 characters without whitespace or control characters");
  }
  const slash = route.indexOf("/");
  if (slash >= 0) {
    // Model ids may themselves contain slashes (e.g. OpenRouter models), but
    // provider/model targets must not start or end with a slash.
    if (slash === 0 || route.endsWith("/")) {
      throw new Error("claudeMessagesRoute must be provider/model or a combo name");
    }
  } else if (!/^[a-zA-Z0-9_.-]+$/.test(route)) {
    throw new Error("claudeMessagesRoute must be provider/model or a combo name");
  }
  return route;
}

export function getClaudeMessagesComboError(combo) {
  if (!combo) return "claudeMessagesRoute target combo does not exist";
  if (combo.isActive === false) return "claudeMessagesRoute target combo is disabled";
  if (combo.kind && combo.kind !== "llm") return "claudeMessagesRoute target must be an LLM combo";
  if (!Array.isArray(combo.models) || combo.models.length === 0) return "claudeMessagesRoute target combo has no models";
  return null;
}
