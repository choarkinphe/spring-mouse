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
    // Legacy provider/model values may contain slashes in the model id, but
    // the target itself must still have a provider prefix and a model suffix.
    if (slash === 0 || route.endsWith("/")) {
      throw new Error("claudeMessagesRoute must be provider/model or a combo name");
    }
  } else if (!/^[a-zA-Z0-9_.-]+$/.test(route)) {
    throw new Error("claudeMessagesRoute must be provider/model or a combo name");
  }
  return route;
}

/**
 * Validate a combo used as a routing target. Shared by the legacy Claude
 * Messages route and per-harness mappings; `label` names the setting in the
 * error so the message points at what the operator actually configured.
 */
export function getComboTargetError(combo, activeModels = null, label = "claudeMessagesRoute") {
  if (!combo) return `${label} target combo does not exist`;
  if (combo.isActive === false) return `${label} target combo is disabled`;
  if (combo.kind && combo.kind !== "llm") {
    return `${label} target must be an LLM combo`;
  }
  if (!Array.isArray(combo.models) || combo.models.length === 0) {
    return `${label} target combo has no models`;
  }
  if (Array.isArray(activeModels) && activeModels.length === 0) {
    return `${label} target combo has no currently available models`;
  }
  return null;
}

export function getClaudeMessagesComboError(combo, activeModels = null) {
  return getComboTargetError(combo, activeModels, "claudeMessagesRoute");
}
