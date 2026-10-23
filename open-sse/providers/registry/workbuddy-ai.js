export default {
  id: "workbuddy-ai",
  // See workbuddy.js: `cbai` is retained so existing model strings and the
  // alias-keyed kv data (custom models, disabled models, overrides) keep working.
  alias: "cbai",
  uiAlias: "cbai",
  aliases: ["wbai"],
  priority: 93,
  display: {
    name: "WorkBuddy AI", icon: "smart_toy", color: "#00B98A", textIcon: "WB",
    website: "https://www.workbuddy.ai",
    notice: { text: "WorkBuddy 国际版。原 CodeBuddy 国际版账号保留原凭据继续可用，建议在方便时重新授权。", signupUrl: "https://www.workbuddy.ai" },
  },
  category: "oauth", hasOAuth: true, authModes: ["oauth"],
  modelListSource: "upstream",
  transport: {
    baseUrl: "https://www.workbuddy.ai/v2/chat/completions",
    forceStream: true, thinkingFormat: "openai",
    auth: { combined: true, header: "Authorization", scheme: "bearer" },
  },
  // Same catalog the CodeBuddy international gateway exposed (mirror of CN).
  models: [
    { id: "glm-5.2", name: "GLM-5.2" },
    { id: "glm-5.1", name: "GLM-5.1" },
    { id: "glm-5.0", name: "GLM-5.0" },
    { id: "glm-5.0-turbo", name: "GLM-5.0-Turbo" },
    { id: "glm-5v-turbo", name: "GLM-5v-Turbo" },
    { id: "glm-4.7", name: "GLM-4.7" },
    { id: "minimax-m3", name: "MiniMax-M3" },
    { id: "minimax-m2.7", name: "MiniMax-M2.7" },
    { id: "kimi-k2.7", name: "Kimi-K2.7-Code" },
    { id: "kimi-k2.6", name: "Kimi-K2.6" },
    { id: "kimi-k2.5", name: "Kimi-K2.5" },
    { id: "hy3-preview", name: "Hy3 Preview" },
    { id: "deepseek-v4-pro", name: "DeepSeek-V4-Pro" },
    { id: "deepseek-v4-flash", name: "DeepSeek-V4-Flash" },
    { id: "deepseek-v3-2-volc", name: "DeepSeek-V3.2" },
  ],
  oauth: {
    productId: "workbuddy-ai", origin: "https://www.workbuddy.ai", platform: "workbuddy-ai",
    stateUrl: "https://www.workbuddy.ai/v2/plugin/auth/state",
    tokenUrl: "https://www.workbuddy.ai/v2/plugin/auth/token",
    refreshUrl: "https://www.workbuddy.ai/v2/plugin/auth/token/refresh",
    pollInterval: 2000,
  },
  features: {
    usage: true,
    // The legacy API-key accounts authenticate the same billing endpoint.
    usageApikey: true,
  },
};
