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
      text: "在浏览器中登录 Devin，使用账号额度直连模型；无需安装 CLI，也不会启动本机 Agent。支持模型家族、思考档位、快速变体及额度读取，具体模型以当前账号目录为准。",
      signupUrl: "https://app.devin.ai",
    },
    // Rendered as a help drawer from the channel notice. Prices are a dated
    // snapshot of the account catalog (GetCliModelConfigs); the live catalog wins.
    billingHelp: {
      title: "Devin 计费规则",
      updatedAt: "2026-11-07",
      sections: [
        {
          heading: "额度不是固定的 Claude 次数",
          items: [
            "Devin 订阅（含 $200/月的 Devin Max）不给固定的 Claude 次数或美元额度，而是按「周额度百分比」计量；部分档位还有日额度（Max 档上游隐藏日额度）。",
            "周额度按账号的重置时间滚动清零（额度卡片里的重置时间即上游 weeklyQuotaResetAt）。用尽后请求会被上游拒绝（HTTP 429，正文为「Your weekly usage quota has been exhausted」），直到重置或使用超额余额；此网关会把该计费模型锁 1 小时再探测，免费模型不受影响。",
            "上游只返回剩余百分比，不返回美元数，所以面板只能显示百分比。",
          ],
        },
        {
          heading: "每次请求扣多少",
          items: [
            "扣减 = 非缓存输入 × 输入单价 + 缓存命中输入 × 缓存单价 + 输出 × 输出单价（单价按每百万 token，来自账号模型目录）。",
            "思考档位（low / medium / high / xhigh / max）单价相同，但档位越高输出（含思考）token 越多，扣得越快。",
            "-fast / -priority 变体单价为 2 倍。SWE-2 系列标记为免费，不消耗周额度；但免费模型仍有单独的速率上限（上游会返回「Reached free model rate limit」，时长从几分钟到数小时不等，Max 档上限更高）。",
            "Agent 场景缓存命中率很高，缓存单价通常只有输入单价的 1/20～1/10，所以长对话的大头往往是输出。",
          ],
        },
        {
          heading: "Claude 模型目录单价（美元 / 百万 token）",
          table: {
            columns: ["模型", "输入", "缓存读", "输出"],
            rows: [
              ["claude-fable-5-1", "10", "0.25", "50"],
              ["claude-5-fable", "10", "1", "50"],
              ["claude-opus-5-5", "4", "0.2", "20"],
              ["claude-opus-5-5-*-fast", "8", "0.4", "40"],
              ["claude-opus-5 / 4-8 / 4-7", "5", "0.5", "25"],
              ["claude-opus-5 / 4-8 *-fast", "10", "1", "50"],
              ["claude-sonnet-5-5", "2", "0.1", "10"],
              ["claude-sonnet-5", "2", "0.2", "10"],
              ["claude-haiku-5-5", "0.1", "0.01", "0.5"],
              ["swe-2-*", "免费", "免费", "免费"],
            ],
          },
        },
        {
          heading: "Max 档大约有多少 Claude 额度（实测估算）",
          items: [
            "2026-11-07 用一个 Devin Max 账号实测：按上表单价折算本周 Claude 用量约 $116，对应周额度从 100% 降到 52%（用掉 48%）。",
            "据此估算一周额度 ≈ $240 的目录价用量，按月约 $1,000。例如全部用 claude-opus-5-5、缓存命中约 90%、平均每次约 9 万输入 token 时，每次约扣 $0.06，一周大约能跑 3,500～4,000 次 Agent 请求。",
            "这是估算：同一账号若在 Devin 网页/IDE 里也在用，会一起扣周额度；上游可能调整额度或单价。",
          ],
        },
        {
          heading: "和本面板费用统计的区别",
          items: [
            "用量页的「费用」按本网关的统一价格表计算，不是 Devin 的扣额度口径，两者会有差异（例如 Fable 5.1 在 Devin 目录里更贵、Sonnet 5.5 更便宜）。",
            "判断还剩多少请看账号的额度卡片（周额度百分比），不要看费用合计。",
          ],
        },
      ],
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
