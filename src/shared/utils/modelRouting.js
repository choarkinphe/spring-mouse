const cleanModel = (value) => (typeof value === "string" && value.trim() ? value.trim() : null);

/**
 * Normalize the request-level model routing metadata shared by usage and
 * observability records. The original value is the model identifier supplied
 * by the client; the executed value is the provider/model that ran this try.
 */
export function createModelRouting({ originalModel, provider, model, executedModel } = {}) {
  const original = cleanModel(originalModel) || cleanModel(executedModel) || (cleanModel(provider) && cleanModel(model) ? `${provider}/${model}` : cleanModel(model));
  const executed = cleanModel(executedModel) || (cleanModel(provider) && cleanModel(model) ? `${provider}/${model}` : cleanModel(model)) || original;
  return {
    originalModel: original,
    executedModel: executed,
  };
}

/**
 * Read routing metadata from a stored usage/detail row, with legacy fallback.
 */
export function normalizeModelRouting(record = {}) {
  const routing = record.routing && typeof record.routing === "object" ? record.routing : {};
  const originalModel = cleanModel(record.originalModel) || cleanModel(routing.originalModel) || cleanModel(record.model);
  const executedModel = cleanModel(record.executedModel) || cleanModel(routing.executedModel) || (cleanModel(record.provider) && cleanModel(record.model) ? `${cleanModel(record.provider)}/${cleanModel(record.model)}` : cleanModel(record.model)) || originalModel;
  return {
    originalModel,
    executedModel,
    routing: { originalModel, executedModel },
  };
}

export function isModelRouted(record = {}) {
  const normalized = normalizeModelRouting(record);
  if (!normalized.originalModel || !normalized.executedModel) return false;
  if (normalized.originalModel === normalized.executedModel) return false;

  // A direct alias may be submitted without its provider prefix. It still maps
  // to the same executed model, so do not turn a direct request into a fake
  // route merely because the stored executed label is `provider/model`.
  const provider = cleanModel(record.provider);
  const model = cleanModel(record.model);
  return !(model && normalized.originalModel === model)
    && !(provider && model && normalized.originalModel === `${provider}/${model}`);
}

export function getExecutedModelLabel(record = {}) {
  const normalized = normalizeModelRouting(record);
  if (normalized.executedModel) return normalized.executedModel;
  const provider = cleanModel(record.provider);
  const model = cleanModel(record.model);
  return provider && model ? `${provider}/${model}` : model || provider || "unknown";
}
