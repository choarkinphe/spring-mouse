import { JEVAPI_CONFIG, JEVAPI_STATIC_MODELS } from "../../config/jevapi.js";

// JevAPI / TypeSafe "System One" — native evaluation service, not a chat LLM.
// serviceKinds omits "llm" so it is never offered as chat; the chat path also
// hard-guards this (src/sse/handlers/chat.js).
export default {
  id: "jevapi",
  alias: "jevapi",
  category: "apikey",
  authType: "apikey",
  display: {
    name: "JevAPI",
    icon: "rule",
    color: "#0EA5E9",
    textIcon: "JE",
    website: "https://jevapi.dev",
    notice: {
      text: "TypeSafe System One 原生决策接口：按类型化问题（noul / choice / score）评估 state 并返回结构化答案，不是聊天模型。API Key 请到 TypeSafe 控制台获取。",
      apiKeyUrl: "https://console.typesafe.ai",
    },
  },
  serviceKinds: ["systemone"],
  // Live model list is authoritative (synced from GET /v1/models, typed systemone).
  modelListSource: "upstream",
  systemoneConfig: {
    baseUrl: JEVAPI_CONFIG.baseUrl,
    modelsUrl: JEVAPI_CONFIG.modelsUrl,
    authType: "apikey",
    authHeader: "bearer",
    defaultModel: JEVAPI_CONFIG.defaultModel,
  },
  modelsFetcher: { url: JEVAPI_CONFIG.modelsUrl, type: "jevapi-systemone" },
  models: JEVAPI_STATIC_MODELS.map((id) => ({ id, name: id, type: "systemone", capabilities: { tools: false } })),
  passthroughModels: true,
};
