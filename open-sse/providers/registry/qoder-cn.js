import qoder from "./qoder.js";

// The regional provider has its own identity, credentials and endpoints.
export default {
  ...qoder,
  id: "qoder-cn",
  alias: "qdcn",
  uiAlias: "qdcn",
  display: {
    ...qoder.display,
    name: "Qoder CN",
    website: "https://qoder.cn",
    notice: { signupUrl: "https://qoder.cn" },
  },
  authHint: "Personal Access Token (pt-...) from https://qoder.cn/account/integrations",
  transport: {
    ...qoder.transport,
    baseUrl: "https://gateway.qoder.com.cn/algo/api/v2/service/pro/sse/agent_chat_generation",
    usage: { url: "https://openapi.qoder.com.cn/sash/api/v2/me/usage" },
  },
  oauth: {
    region: "cn",
    openApiBaseUrl: "https://openapi.qoder.com.cn",
    chatBaseUrl: "https://gateway.qoder.com.cn",
    deviceTokenUrl: "https://openapi.qoder.com.cn/api/v1/deviceToken/poll",
    userInfoUrl: "https://openapi.qoder.com.cn/api/v1/userinfo",
    quotaUsageUrl: "https://openapi.qoder.com.cn/api/v2/quota/usage",
    loginUrl: "https://qoder.cn/device/selectAccounts",
  },
  features: { ...qoder.features },
};
