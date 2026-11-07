import { DEVIN } from "../../config/devin.js";

// Direct model inference only. The disabled devin-cli ACP agent remains separate.
export default {
  id: "devin",
  alias: "dvn",
  uiAlias: "dvn",
  display: {
    name: "Devin",
    icon: "smart_toy",
    color: "#3B82F6",
    textIcon: "DV",
    website: "https://devin.ai",
    notice: {
      text: "在浏览器中登录 Devin，使用账号额度直连模型；无需安装 CLI，也不会启动本机 Agent。模型家族、思考档位、快速变体及额度读取对齐 magpie 的 Devin 接入，具体模型以当前账号目录为准。",
      signupUrl: "https://app.devin.ai",
    },
  },
  category: "oauth",
  authModes: ["oauth"],
  hasOAuth: true,
  passthroughModels: true,
  transport: {
    baseUrl: `${DEVIN.baseUrl}${DEVIN.chatPath}`,
    format: "openai",
    forceStream: true,
  },
  features: { usage: true },
  // Deliberately no guessed catalog: synchronize the authenticated directory.
  models: [],
  oauth: {
    authorizeUrl: "https://app.devin.ai/auth/cli/continue",
    tokenUrl: "https://server.codeium.com/exa.seat_management_pb.SeatManagementService/ExchangeDevinCLIPKCECode",
    profileUrl: "https://server.codeium.com/exa.seat_management_pb.SeatManagementService/GetUserStatus",
    codeChallengeMethod: "S256",
  },
};
