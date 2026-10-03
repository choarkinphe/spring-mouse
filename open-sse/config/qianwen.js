// Qianwen AI Platform (CN), not the older DashScope Coding Plan / intl endpoints.
// Docs: https://platform.qianwenai.com/docs/developer-guides/clients-and-developer-tools/codex
export const QIANWEN_PROVIDER_IDS = ["qianwen", "qianwen-token-plan"];

export const QIANWEN_ENDPOINTS = {
  qianwen: {
    chat: "https://maas.qianwenaiapi.com/compatible-mode/v1/chat/completions",
    responses: "https://maas.qianwenaiapi.com/compatible-mode/v1/responses",
    messages: "https://maas.qianwenaiapi.com/apps/anthropic/v1/messages",
    models: "https://maas.qianwenaiapi.com/compatible-mode/v1/models",
  },
  "qianwen-token-plan": {
    chat: "https://token-plan.maas.qianwenaiapi.com/compatible-mode/v1/chat/completions",
    responses: "https://token-plan.maas.qianwenaiapi.com/compatible-mode/v1/responses",
    messages: "https://token-plan.maas.qianwenaiapi.com/apps/anthropic/v1/messages",
    models: "https://token-plan.maas.qianwenaiapi.com/compatible-mode/v1/models",
  },
};

// Official personal/team text-model lists, 2026-10-03. The live /models list
// remains account-specific; this seed lets users configure a channel offline.
export const QIANWEN_MODELS = [
  { id: "qwen3.8-flash", name: "Qwen3.8 Flash" },
  { id: "qwen3.8-max", name: "Qwen3.8 Max" },
  { id: "qwen3.7-max", name: "Qwen3.7 Max" },
  { id: "qwen3.7-plus", name: "Qwen3.7 Plus" },
  { id: "qwen3.6-plus", name: "Qwen3.6 Plus" },
  { id: "qwen3.6-flash", name: "Qwen3.6 Flash" },
  { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro" },
  { id: "deepseek-v4-pro-0813", name: "DeepSeek V4 Pro 0813" },
  { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash" },
  { id: "deepseek-v4-flash-0731", name: "DeepSeek V4 Flash 0731" },
  { id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash" },
  { id: "deepseek-v3.2", name: "DeepSeek V3.2" },
  { id: "kimi-k2.7-code", name: "Kimi K2.7 Code" },
  { id: "kimi-k2.6", name: "Kimi K2.6" },
  { id: "kimi-k2.5", name: "Kimi K2.5" },
  { id: "glm-5.3", name: "GLM 5.3" },
  { id: "glm-5.2", name: "GLM 5.2" },
  { id: "glm-5.1", name: "GLM 5.1" },
  { id: "glm-5", name: "GLM 5" },
  { id: "MiniMax-M2.5", name: "MiniMax M2.5" },
];

export const QIANWEN_TOKEN_PLAN_MODELS = [
  { id: "auto", name: "Auto (Token Plan)" },
  ...QIANWEN_MODELS,
  { id: "qwen3.8-max-preview", name: "Qwen3.8 Max Preview (legacy)", upstreamModelId: "qwen3.8-max" },
  { id: "decision-model-preview", name: "Decision Model Preview" },
];

// Provider overrides prevent family heuristics from marking qwen3.7-max as
// visual, or overlooking DeepSeek V4.1 Flash's native image input.
export const QIANWEN_CAPABILITIES = {
  auto: { reasoning: true, thinkingFormat: "qwen" },
  "qwen3.8-flash": { vision: true, videoInput: true, reasoning: true, thinkingFormat: "qwen", contextWindow: 1000000, maxOutput: 131072 },
  "qwen3.8-max": { vision: true, pdf: true, videoInput: true, reasoning: true, thinkingFormat: "qwen", contextWindow: 1000000, maxOutput: 131072 },
  "qwen3.8-max-preview": { vision: true, pdf: true, videoInput: true, reasoning: true, thinkingFormat: "qwen", contextWindow: 1000000, maxOutput: 131072 },
  "qwen3.7-max": { vision: false, videoInput: false, reasoning: true, thinkingFormat: "qwen", contextWindow: 1000000, maxOutput: 131072 },
  "deepseek-v4.1-flash": { vision: true, reasoning: true, thinkingFormat: "deepseek", contextWindow: 1000000, maxOutput: 384000 },
  "glm-5.3": { vision: false, reasoning: true, thinkingFormat: "zai", thinkingCanDisable: false, contextWindow: 1000000, maxOutput: 131072 },
};

// USD / 1M token reference estimates from models.dev's alibaba-cn catalog,
// 2026-10-03. NOT RMB invoice prices, Token Plan Credits, or tier-aware billing.
// Hand-configured channel prices still take precedence.
export const QIANWEN_REFERENCE_PRICING = {
  "qwen3.8-flash": { input: 0.11875, output: 0.40073, cached: 0.01187, cache_creation: 0.14844 },
  "qwen3.8-max": { input: 1.77744, output: 5.33231, cached: 0.22218, cache_creation: 2.22179 },
  "qwen3.8-max-preview": { input: 1.77744, output: 5.33231, cached: 0.22218, cache_creation: 2.22179 },
  "qwen3.7-max": { input: 2.5, output: 7.5, cached: 0.5, cache_creation: 3.125 },
  "qwen3.7-plus": { input: 0.5, output: 3, cached: 0.05, cache_creation: 0.625 },
  "qwen3.6-flash": { input: 0.1875, output: 1.125, cache_creation: 0.234375 },
  "glm-5.3": { input: 1.1, output: 3.851, cached: 0.275, cache_creation: 0 },
  "glm-5.2": { input: 1.1, output: 3.851, cached: 0.275, cache_creation: 0 },
  "deepseek-v4-pro": { input: 0.435, output: 0.87, cached: 0.003625 },
  "deepseek-v4-pro-0813": { input: 0.435, output: 0.87, cached: 0.003625 },
  "deepseek-v4.1-flash": { input: 0.29754, output: 1.19015, cached: 0.01488 },
};

export function qianwenTransports(provider) {
  const endpoints = QIANWEN_ENDPOINTS[provider];
  const auth = { combined: true, header: "Authorization", scheme: "bearer" };
  return [
    { format: "openai", baseUrl: endpoints.chat, auth },
    { format: "openai-responses", baseUrl: endpoints.responses, auth },
    { format: "claude", baseUrl: endpoints.messages, headers: { "anthropic-version": "2023-06-01" }, auth },
  ];
}
