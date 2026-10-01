const cleanModel = (value) => (typeof value === "string" && value.trim() ? value.trim() : null);
const ROUTE_KINDS = new Set(["direct", "alias", "combo", "harness"]);

/**
 * Normalize the request-level model routing metadata shared by usage and
 * observability records. The original value is the model identifier supplied
 * by the client; the executed value is the provider/model that ran this try.
 */
export function createModelRouting({ originalModel, provider, model, executedModel, routeKind, routed } = {}) {
  const original = cleanModel(originalModel) || cleanModel(executedModel) || (cleanModel(provider) && cleanModel(model) ? `${provider}/${model}` : cleanModel(model));
  const executed = cleanModel(executedModel) || (cleanModel(provider) && cleanModel(model) ? `${provider}/${model}` : cleanModel(model)) || original;
  const normalizedKind = ROUTE_KINDS.has(routeKind) ? routeKind : null;
  return {
    originalModel: original,
    executedModel: executed,
    ...(normalizedKind ? { routeKind: normalizedKind } : {}),
    ...(typeof routed === "boolean" ? { routed } : {}),
  };
}

/**
 * Read routing metadata from a stored usage/detail row, with legacy fallback.
 */
export function normalizeModelRouting(record = {}) {
  const routing = record.routing && typeof record.routing === "object" ? record.routing : {};
  const originalModel = cleanModel(record.originalModel) || cleanModel(routing.originalModel) || cleanModel(record.model);
  const executedModel = cleanModel(record.executedModel) || cleanModel(routing.executedModel) || (cleanModel(record.provider) && cleanModel(record.model) ? `${cleanModel(record.provider)}/${cleanModel(record.model)}` : cleanModel(record.model)) || originalModel;
  const routeKind = ROUTE_KINDS.has(record.routeKind) ? record.routeKind : ROUTE_KINDS.has(routing.routeKind) ? routing.routeKind : null;
  const explicitRouted = typeof record.routed === "boolean" ? record.routed : typeof routing.routed === "boolean" ? routing.routed : undefined;
  return {
    originalModel,
    executedModel,
    routing: {
      originalModel,
      executedModel,
      ...(routeKind ? { routeKind } : {}),
      ...(explicitRouted !== undefined ? { routed: explicitRouted } : {}),
    },
  };
}

function inferredProvider(model) {
  if (/^(gpt-|o[134])/i.test(model || "")) return "openai";
  if (/^claude-/i.test(model || "")) return "anthropic";
  if (/^gemini-/i.test(model || "")) return "gemini";
  if (/^deepseek-/i.test(model || "")) return "openrouter";
  return null;
}

export function isModelRouted(record = {}) {
  const normalized = normalizeModelRouting(record);
  if (!normalized.originalModel || !normalized.executedModel) return false;
  if (normalized.originalModel === normalized.executedModel) return false;
  const storedRouting = record.routing && typeof record.routing === "object" ? record.routing : {};
  const explicitRouted = typeof record.routed === "boolean" ? record.routed : storedRouting.routed;
  if (typeof explicitRouted === "boolean") return explicitRouted;

  // A provider-qualified original already names the executed route.
  const provider = cleanModel(record.provider);
  const model = cleanModel(record.model);
  if (provider && model && normalized.originalModel === `${provider}/${model}`) return false;

  // Legacy rows have no route source. Preserve the direct-alias guard for the
  // provider inferred from the public model name, but expose a same-name route
  // when the stored provider differs (e.g. gpt-6-sol → codex/gpt-6-sol).
  if (model && normalized.originalModel === model) {
    return provider !== inferredProvider(model);
  }
  return true;
}

export function getExecutedModelLabel(record = {}) {
  const normalized = normalizeModelRouting(record);
  if (normalized.executedModel) return normalized.executedModel;
  const provider = cleanModel(record.provider);
  const model = cleanModel(record.model);
  return provider && model ? `${provider}/${model}` : model || provider || "unknown";
}
