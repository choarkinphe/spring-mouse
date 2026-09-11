// Single source of truth for the capability keys we persist / expose. Shared by
// the dashboard (`useModelCaps`), the model list API and the capability editor.
export const MODEL_CAPABILITY_KEYS = [
  "vision",
  "pdf",
  "audioInput",
  "videoInput",
  "imageOutput",
  "audioOutput",
  "search",
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

// Project a full capability object down to the fields the dashboard consumes so
// /api/models and useModelCaps stay in sync with the editor's checkbox set.
export function pickModelCapabilities(capabilities = {}) {
  const picked = {};
  for (const key of MODEL_CAPABILITY_KEYS) {
    const value = capabilities?.[key];
    if (value !== undefined && value !== null) picked[key] = value;
  }
  return picked;
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

// ── models.dev catalog resolution ────────────────────────────────────────────
// Provider entries may declare an explicit `modelCatalog`; everything else is
// resolved through this table so the dashboard's "sync supported models" action
// can fall back to the public catalog instead of only trusting whatever the
// provider's own /models endpoint happens to return for the current account.

export const MODELS_DEV_CATALOG_URL = "https://models.dev/api.json";

export const MODELS_DEV_PROVIDER_KEYS = {
  // Anthropic / OpenAI / Google first-party
  claude: "anthropic",
  anthropic: "anthropic",
  openai: "openai",
  codex: "openai",
  gemini: "google",
  "gemini-cli": "google",
  github: "github-copilot",
  // Aggregators & OpenAI-compatible platforms
  openrouter: "openrouter",
  "vercel-ai-gateway": "vercel",
  together: "togetherai",
  fireworks: "fireworks-ai",
  nebius: "nebius",
  siliconflow: "siliconflow",
  chutes: "chutes",
  nvidia: "nvidia",
  hyperbolic: "hyper",
  cerebras: "cerebras",
  cohere: "cohere",
  groq: "groq",
  mistral: "mistral",
  deepseek: "deepseek",
  xai: "xai",
  "grok-cli": "xai",
  perplexity: "perplexity",
  "perplexity-agent": "perplexity-agent",
  ollama: "ollama-cloud",
  // Z.ai / Zhipu
  "glm-cn": "zhipuai-coding-plan",
  glm: "zai-coding-plan",
  // MiniMax
  minimax: "minimax-coding-plan",
  "minimax-cn": "minimax-cn",
  // Moonshot / Kimi
  kimi: "kimi-for-coding",
  // Alibaba DashScope (CN + intl coding / general endpoints)
  alicode: "alibaba-coding-plan-cn",
  "alicode-intl": "alibaba-coding-plan",
  "alims-intl": "alibaba",
  // Volcengine Ark
  "volcengine-ark": "volcengine-coding-plan",
  // Xiaomi / Tencent
  "xiaomi-mimo": "xiaomi",
  "xiaomi-tokenplan": "xiaomi-token-plan-cn",
  tencent: "tencent-coding-plan",
};

/**
 * Resolve the models.dev provider key for a channel.
 * Explicit registry `modelCatalog.provider` always wins.
 */
export function resolveModelsDevProviderKey(providerId, explicitKey = null) {
  if (explicitKey) return explicitKey;
  if (!providerId) return null;
  return MODELS_DEV_PROVIDER_KEYS[providerId] || null;
}

/** True when the shared catalog can contribute models to this channel. */
export function hasModelsDevCatalog(providerId) {
  return Boolean(resolveModelsDevProviderKey(providerId));
}

const MODELS_DEV_TTL_MS = 10 * 60 * 1000;
let catalogCache = null; // { at, data }

/**
 * Fetch (and briefly cache) the shared models.dev catalog payload.
 * Returns null when the catalog is unreachable — callers must fail open.
 */
export async function fetchModelsDevCatalog({ url = MODELS_DEV_CATALOG_URL, fetchImpl = fetch, now = Date.now() } = {}) {
  if (catalogCache && now - catalogCache.at < MODELS_DEV_TTL_MS) return catalogCache.data;
  try {
    const response = await fetchImpl(url, { cache: "no-store" });
    if (!response?.ok) return null;
    const data = await response.json();
    catalogCache = { at: now, data };
    return data;
  } catch {
    return null;
  }
}

export function resetModelsDevCatalogCache() {
  catalogCache = null;
}

// `source` values persisted on synchronized rows — the dashboard renders these
// as badges so it is obvious where each entry came from.
export const SYNC_SOURCE_OFFICIAL = "official";
export const SYNC_SOURCE_CATALOG = "catalog";

/**
 * Union a provider's own /models list with the shared capability catalog.
 *
 * The provider's endpoint is authoritative but frequently only a subset of what
 * the channel supports (account tier, pagination, missing vision variants), so an
 * intersection silently loses models. Official ids keep their naming, everything
 * else is tagged as catalog-only.
 *
 * @param {{ officialModels?: Array, catalogModels?: Array }} input
 * @returns {{ models: Array, catalogOnlyCount: number }}
 */
export function mergeSyncedModels({ officialModels = [], catalogModels = [] } = {}) {
  const merged = new Map();
  for (const model of officialModels) {
    if (!model?.id) continue;
    merged.set(model.id, { ...model, source: SYNC_SOURCE_OFFICIAL });
  }

  let catalogOnlyCount = 0;
  for (const model of catalogModels) {
    if (!model?.id || merged.has(model.id)) continue;
    merged.set(model.id, { ...model, source: SYNC_SOURCE_CATALOG });
    catalogOnlyCount += 1;
  }

  return { models: Array.from(merged.values()), catalogOnlyCount };
}
