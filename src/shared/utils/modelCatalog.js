const MODEL_CAPABILITY_KEYS = [
  "vision",
  "pdf",
  "audioInput",
  "videoInput",
  "imageOutput",
  "audioOutput",
  "tools",
  "reasoning",
  "contextWindow",
  "maxOutput",
];

export function normalizeModelCapabilities(capabilities = {}) {
  const normalized = {};
  for (const key of MODEL_CAPABILITY_KEYS) {
    const value = capabilities?.[key];
    if (typeof value === "boolean") normalized[key] = value;
    if ((key === "contextWindow" || key === "maxOutput") && Number.isFinite(value) && value > 0) {
      normalized[key] = value;
    }
  }
  return normalized;
}

export function capabilitiesFromModelsDev(model = {}) {
  const input = new Set(model.modalities?.input || []);
  const output = new Set(model.modalities?.output || []);
  return normalizeModelCapabilities({
    vision: input.has("image"),
    pdf: input.has("pdf"),
    audioInput: input.has("audio"),
    videoInput: input.has("video"),
    imageOutput: output.has("image"),
    audioOutput: output.has("audio"),
    tools: model.tool_call === true,
    reasoning: model.reasoning === true,
    contextWindow: model.limit?.context,
    maxOutput: model.limit?.output,
  });
}

export function parseModelsDevCatalog(payload, providerKey) {
  const provider = payload?.[providerKey];
  if (!provider?.models || typeof provider.models !== "object") return [];

  return Object.values(provider.models)
    .map((model) => {
      const id = model?.id;
      if (!id) return null;
      return {
        id,
        name: model.name || id,
        type: "llm",
        capabilities: capabilitiesFromModelsDev(model),
        releaseDate: model.release_date || null,
        lastUpdated: model.last_updated || null,
      };
    })
    .filter(Boolean)
    .sort((a, b) => {
      const dateOrder = String(b.releaseDate || "").localeCompare(String(a.releaseDate || ""));
      return dateOrder || a.id.localeCompare(b.id);
    });
}
