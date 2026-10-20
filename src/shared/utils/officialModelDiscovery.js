// Shared wire contract. A directory is evidence of discovery, not of successful
// inference or account entitlement (public directories especially are not).
export function validateOfficialModels(models) {
  if (!Array.isArray(models)) throw new Error("Upstream returned an invalid model list");
  const seen = new Set();
  return models.map((model) => {
    const item = typeof model === "string" ? { id: model } : model;
    if (!item || typeof item !== "object" || Array.isArray(item)
      || typeof item.id !== "string" || !item.id.trim() || item.id !== item.id.trim()) {
      throw new Error("Upstream returned an invalid model list");
    }
    if (seen.has(item.id)) return null;
    seen.add(item.id);
    return { ...item, id: item.id, name: typeof item.name === "string" && item.name ? item.name : item.id };
  }).filter(Boolean);
}

export function parseOfficialModelPayload(data, shape = "openai") {
  if (!data || typeof data !== "object" || data.error || data.warning
    || data.success === false || (data.code !== undefined && ![0, 200, "0", "200"].includes(data.code))) {
    throw new Error("Upstream returned an invalid model list");
  }
  let models;
  if (shape === "ollama") models = data.models;
  else if (shape === "gemini") models = data.models;
  else if (shape === "cohere") models = data.models ?? data.data;
  else models = Array.isArray(data) ? data : data.data ?? data.models ?? data.results;
  if (!Array.isArray(models)) throw new Error("Upstream returned an invalid model list");
  return validateOfficialModels(models.map((model) => {
    if (typeof model === "string") return model;
    if (!model || typeof model !== "object") return model;
    // These are documented upstream identifiers, not display-name fallbacks.
    const id = model.id ?? model.slug ?? model.model_id
      ?? (["ollama", "gemini", "cohere"].includes(shape) ? model.model ?? model.name : undefined);
    return { ...model, id, name: model.display_name || model.displayName || model.name || id };
  }));
}

export function isSuccessfulOfficialDiscovery(data) {
  return data?.discovery?.status === "success"
    && data.discovery.source === "official"
    && ["public", "account"].includes(data.discovery.scope)
    && !data.error && !data.warning && Array.isArray(data.models);
}

export function officialDiscovery(models, scope = "account") {
  return { status: "success", source: "official", scope, fetchedAt: new Date().toISOString(), count: models.length };
}
