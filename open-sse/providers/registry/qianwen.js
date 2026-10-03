import { QIANWEN_ENDPOINTS, QIANWEN_MODELS, qianwenTransports } from "../../config/qianwen.js";

export default {
  id: "qianwen",
  alias: "qianwen",
  priority: 12,
  category: "apikey",
  display: {
    name: "千问 API",
    icon: "cloud",
    color: "#615CED",
    textIcon: "QW",
    website: "https://www.qianwenai.com",
    notice: {
      text: "按量计费，使用平台 API Key（sk-ws- / 旧版 sk-），不要使用 Token Plan 的 sk-sp- Key。成本为美元参考估算，人民币账单、上下文阶梯及工具费用以平台为准。",
      apiKeyUrl: "https://platform.qianwenai.com/home/api-keys",
    },
  },
  transport: {
    baseUrl: QIANWEN_ENDPOINTS.qianwen.chat,
    validateUrl: QIANWEN_ENDPOINTS.qianwen.models,
    streamUsage: true,
    thinkingFormats: { openai: "qwen", "openai-responses": "qwen-responses", claude: "claude-budget" },
  },
  transports: qianwenTransports("qianwen"),
  modelCatalog: { type: "models-dev", provider: "alibaba-cn" },
  models: QIANWEN_MODELS,
  passthroughModels: true,
};
