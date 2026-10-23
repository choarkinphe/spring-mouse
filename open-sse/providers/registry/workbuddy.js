export default {
  id: "workbuddy",
  // The previous CodeBuddy aliases stay here on purpose: custom models, disabled
  // models, capability overrides and model aliases are all keyed by provider
  // ALIAS in the kv store, and users have years of `cbcn/...` model strings in
  // combos. Keeping the alias means migration 027 only has to move provider ids.
  alias: "cbcn",
  uiAlias: "cbcn",
  aliases: ["wb"],
  priority: 92,
  display: {
    name: "WorkBuddy (China)", icon: "smart_toy", color: "#5B5BD6", textIcon: "WB",
    website: "https://copilot.tencent.com",
    notice: { text: "WorkBuddy 国内版（CodeBuddy 套餐）。原 CodeBuddy 国内版账号已原地迁移。", signupUrl: "https://copilot.tencent.com" },
  },
  category: "oauth", hasOAuth: true, authModes: ["oauth"],
  modelListSource: "upstream",
  transport: {
    baseUrl: "https://copilot.tencent.com/v2/chat/completions",
    forceStream: true, thinkingFormat: "openai",
    auth: { combined: true, header: "Authorization", scheme: "bearer" },
  },
  // The CodeBuddy CN gateway catalog, carried over unchanged by the replacement
  // so a fresh install still has a usable list before the first account sync.
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
    productId: "workbuddy", origin: "https://copilot.tencent.com", platform: "workbuddy",
    stateUrl: "https://copilot.tencent.com/v2/plugin/auth/state",
    tokenUrl: "https://copilot.tencent.com/v2/plugin/auth/token",
    refreshUrl: "https://copilot.tencent.com/v2/plugin/auth/token/refresh",
    pollInterval: 2000,
  },
  // Quota is the shared Tencent billing endpoint (see services/usage/codebuddy-cn.js).
  // Omitting this flag hides the quota panel and its refresh button entirely.
  features: {
    usage: true,
  },
};
