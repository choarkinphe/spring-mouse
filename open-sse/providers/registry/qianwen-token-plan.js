import { QIANWEN_ENDPOINTS, QIANWEN_TOKEN_PLAN_MODELS, qianwenTransports } from "../../config/qianwen.js";

export default {
  id: "qianwen-token-plan",
  alias: "qianwen-token-plan",
  priority: 13,
  category: "apikey",
  display: {
    name: "千问 Token Plan",
    icon: "cloud",
    color: "#615CED",
    textIcon: "QTP",
    website: "https://platform.qianwenai.com/pricing/token-plan",
    notice: {
      text: "个人 / 团队订阅使用对应的 sk-sp- Key，不能与按量 API Key 混用。模型权限按套餐和上游 /models 为准。美元成本仅为参考估算，不是 Credits 扣费；余额请查看平台控制台。",
      apiKeyUrl: "https://platform.qianwenai.com/home/api-keys",
    },
  },
  transport: {
    baseUrl: QIANWEN_ENDPOINTS["qianwen-token-plan"].chat,
    validateUrl: QIANWEN_ENDPOINTS["qianwen-token-plan"].models,
    streamUsage: true,
    thinkingFormats: { openai: "qwen", "openai-responses": "qwen-responses", claude: "claude-budget" },
  },
  transports: qianwenTransports("qianwen-token-plan"),
  modelCatalog: { type: "models-dev", provider: "alibaba-token-plan-cn" },
  models: QIANWEN_TOKEN_PLAN_MODELS,
  passthroughModels: true,
};
