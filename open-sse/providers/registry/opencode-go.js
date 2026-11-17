export default {
  id: "opencode-go",
  priority: 210,
  alias: "opencode-go",
  aliases: [
    "ocg",
  ],
  uiAlias: "ocg",
  display: {
    name: "OpenCode Go",
    icon: "terminal",
    color: "#E87040",
    textIcon: "OC",
    website: "https://opencode.ai/auth",
    notice: {
      text: "OpenCode Go subscription: Go $10/mo, Go Plus $40/mo (Go Teams $20/member/mo). Per-model monthly dollar allowances; overage optional via Extra Usage → Zen balance. See https://opencode.ai/docs/go/",
      apiKeyUrl: "https://opencode.ai/auth",
    },
    billingHelp: {
      title: "OpenCode Go 计费规则",
      updatedAt: "2026-11-17",
      sections: [
        {
          heading: "订阅额度按美元计量",
          items: [
            "Go（$10/月）、Go Plus（$40/月）、Go Teams（$20/人/月，每模型比 Go 多 $5）三档；各档 token 单价相同，区别只在每模型的月度美元额度。",
            "额度按模型分级：多数折扣模型 Go 档为 $60/月，中间档 $30（Qwen3.8 Flash、Hy4 preview 等），未谈下折扣的贵价模型为 $15/月（Kimi K3、GLM-5.3、Grok 4.7、GPT Luna、Claude Haiku 等）。限时免费模型（Beam、LongCat 2.5 Free 等）不限量。",
            "每模型额度再切窗口：5 小时 = 月额度的 20%，周 = 50%，月 = 100%。额度卡片的重置时间对应这些窗口。",
            "额度耗尽后请求默认被拒；在 Console 打开「Extra Usage」可回退到 Zen 预付余额按 token 单价扣费（Go Teams 默认开启）。",
          ],
        },
        {
          heading: "用量换算",
          items: [
            "扣减 = 非缓存输入 × 输入单价 + 缓存命中 × 缓存单价 + 输出 × 输出单价（美元/百万 token）。编码 agent 缓存命中率高，缓存单价常只有输入价的 1/10～1/5，长对话大头通常是输出。",
            "DeepSeek 系列在工作日高峰时段（UTC 周一至五 01:00-04:00 与 06:00-10:00，对应北京时间 09:00-12:00 与 14:00-18:00）单价 ×2，其余时段与周末为基准价。",
            "长上下文分段加价：Grok >200K、GPT Luna >272K、Claude Haiku >100K、Qwen3.7 Plus >256K tokens 后单价上浮约 2 倍。",
          ],
        },
        {
          heading: "额度卡片与美元换算（本面板）",
          items: [
            "上游 usage 接口只返回窗口百分比，不返回美元。账号配置 goPlan（go / go-plus / go-teams）后，面板按该档最大单模型月度额度把百分比折算为美元显示；未配置时只显示百分比。",
          ],
        },
      ],
    },
  },
  category: "apikey",
  features: { usage: true, usageApikey: true },
  // The public Go /models directory is authoritative for discovery, not proof
  // of access for a particular subscription. Seeds below only retain metadata.
  modelListSource: "upstream",
  transport: {
    baseUrl: "https://opencode.ai/inference/go/openai/v1/chat/completions",
    headers: {},
    usage: {
      url: "https://opencode.ai/zen/go/v1/usage",
      windows: { rolling: "5-hour", weekly: "Weekly", monthly: "Monthly" },
      // Per-model monthly dollar allowance per plan, from https://opencode.ai/docs/go/
      // (percent windows: 5-hour = 20%, weekly = 50%, monthly = 100% of these values).
      // Window shares of the monthly limit are plan-invariant, so one number per
      // plan per model converts the API's percent into dollars. Unlimited = 0
      // (free limited-time models); null = not published for that model.
      planLimits: {
        go: {
          "glm-5.3-flash": 60, "glm-5.3": 15, "glm-5.2": 60,
          "kimi-k3.1-pro": 15, "kimi-k3": 15, "kimi-k2.7-code": 60,
          "longcat-2.0": 60, "step-5-preview": 15,
          "beam-free": 0, "iceman-contributor-free": 0, "longcat-2.5-free": 0, "hy4-flash-free": 0,
          "mimo-v2.6-flash": 60, "mimo-v2.6-pro": 15, "mimo-v2.5": 60, "mimo-v2.5-pro": 15,
          "minimax-m3.1-flash": 20, "minimax-m3": 60,
          "muse-spark-1.3-contributor": 60, "muse-spark-1.2-contributor": 60,
          "qwen4-max": 15, "qwen3.8-max": 15, "qwen3.8-flash": 30, "qwen3.7-plus": 60,
          "deepseek-v4.1-flash": 100, "deepseek-v4-pro": 15,
          "hy4": 60, "hy4-preview": 30, "hy3": 60,
          "grok-4.7": 15, "gpt-6-luna": 15, "gpt-5.6-luna": 15, "claude-haiku-5-5": 15,
          "gemini-4-argon": 30,
        },
        "go-plus": {
          "glm-5.3-flash": 180, "glm-5.3": 120, "glm-5.2": 180,
          "kimi-k3.1-pro": 60, "kimi-k3": 60, "kimi-k2.7-code": 180,
          "longcat-2.0": 240, "step-5-preview": 60,
          "beam-free": 0, "iceman-contributor-free": 0, "longcat-2.5-free": 0, "hy4-flash-free": 0,
          "mimo-v2.6-flash": 120, "mimo-v2.6-pro": 60, "mimo-v2.5": 120, "mimo-v2.5-pro": 60,
          "minimax-m3.1-flash": 80, "minimax-m3": 180,
          "muse-spark-1.3-contributor": 120, "muse-spark-1.2-contributor": 120,
          "qwen4-max": 60, "qwen3.8-max": 60, "qwen3.8-flash": 90, "qwen3.7-plus": 180,
          "deepseek-v4.1-flash": 300, "deepseek-v4-pro": 60,
          "hy4": 180, "hy4-preview": 90, "hy3": 180,
          "grok-4.7": 60, "gpt-6-luna": 60, "gpt-5.6-luna": 60, "claude-haiku-5-5": 60,
          "gemini-4-argon": 90,
        },
        // Go Teams is per-member: Go's limit + $5 per model (doc: "a $5/month
        // higher limit than Go on every model").
        "go-teams": {
          "glm-5.3-flash": 65, "glm-5.3": 20, "glm-5.2": 65,
          "kimi-k3.1-pro": 20, "kimi-k3": 20, "kimi-k2.7-code": 65,
          "longcat-2.0": 65, "step-5-preview": 20,
          "beam-free": 0, "iceman-contributor-free": 0, "longcat-2.5-free": 0, "hy4-flash-free": 0,
          "mimo-v2.6-flash": 65, "mimo-v2.6-pro": 20, "mimo-v2.5": 65, "mimo-v2.5-pro": 20,
          "minimax-m3.1-flash": 25, "minimax-m3": 65,
          "muse-spark-1.3-contributor": 65, "muse-spark-1.2-contributor": 65,
          "qwen4-max": 20, "qwen3.8-max": 20, "qwen3.8-flash": 35, "qwen3.7-plus": 65,
          "deepseek-v4.1-flash": 105, "deepseek-v4-pro": 20,
          "hy4": 65, "hy4-preview": 35, "hy3": 65,
          "grok-4.7": 20, "gpt-6-luna": 20, "gpt-5.6-luna": 20, "claude-haiku-5-5": 20,
          "gemini-4-argon": 35,
        },
      },
      // 5h/weekly windows are shares of the monthly allowance (docs: 20% / 50%).
      windowShare: { rolling: 0.2, weekly: 0.5 },
    },
    // Public catalog additions do not establish Messages/Responses support.
    unknownModelFormats: ["openai"],
  },
  // Keep known per-model protocol support, but use the currently documented
  // OpenAI route for chat. Do not infer other protocols for newly synced IDs.
  transports: [
    { format: "openai", baseUrl: "https://opencode.ai/inference/go/openai/v1/chat/completions", auth: { combined: true, header: "Authorization", scheme: "bearer" } },
    { format: "claude", baseUrl: "https://opencode.ai/zen/go/v1/messages", auth: { combined: true, header: "x-api-key", scheme: "raw", anthropicVersion: true } },
    { format: "openai-responses", baseUrl: "https://opencode.ai/zen/go/v1/responses", auth: { combined: true, header: "Authorization", scheme: "bearer" } },
  ],
  models: [
    // Seed metadata aligned to the public Go catalog (2026-11-17 snapshot,
    // https://opencode.ai/inference/go/v1/models). modelListSource "upstream"
    // syncs the live list; these seeds cover first-load names/formats.
    { id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash 1017", supportedFormats: ["openai"] },
    { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", supportedFormats: ["openai"] },
    { id: "glm-5.2", name: "GLM-5.2", supportedFormats: ["openai"] },
    { id: "glm-5.3", name: "GLM-5.3", supportedFormats: ["openai"] },
    { id: "glm-5.3-flash", name: "GLM-5.3-Flash", supportedFormats: ["openai"] },
    { id: "grok-4.7", name: "Grok 4.7", supportedFormats: ["openai-responses"] },
    { id: "muse-spark-1.2-contributor", name: "Muse Spark 1.2 Contributor", supportedFormats: ["openai-responses"] },
    { id: "muse-spark-1.3-contributor", name: "Muse Spark 1.3 Contributor", supportedFormats: ["openai-responses"] },
    { id: "gpt-5.6-luna", name: "GPT 5.6 Luna", supportedFormats: ["openai-responses"] },
    { id: "gpt-6-luna", name: "GPT 6 Luna", supportedFormats: ["openai-responses"] },
    { id: "claude-haiku-5-5", name: "Claude Haiku 5.5", supportedFormats: ["claude"] },
    { id: "hy3", name: "Hy3", supportedFormats: ["openai"] },
    { id: "hy4", name: "Hy4", supportedFormats: ["openai"] },
    { id: "hy4-preview", name: "Hy4 preview", supportedFormats: ["openai"] },
    { id: "kimi-k2.7-code", name: "Kimi K2.7 Code", supportedFormats: ["openai"] },
    { id: "kimi-k3", name: "Kimi K3", supportedFormats: ["openai"] },
    { id: "kimi-k3.1-pro", name: "Kimi K3.1 Pro", supportedFormats: ["openai"] },
    { id: "mimo-v2.6-flash", name: "MiMo-V2.6-Flash", supportedFormats: ["openai"] },
    { id: "mimo-v2.6-pro", name: "MiMo-V2.6-Pro", supportedFormats: ["openai"] },
    { id: "minimax-m3", name: "MiniMax-M3", supportedFormats: ["claude"] },
    { id: "minimax-m3.1-flash", name: "MiniMax M3.1 Flash", supportedFormats: ["openai"] },
    { id: "longcat-2.0", name: "LongCat-2.0", supportedFormats: ["openai"] },
    { id: "longcat-2.5-free", name: "LongCat 2.5 Free", supportedFormats: ["openai"] },
    { id: "step-5-preview", name: "Step 5 Preview", supportedFormats: ["openai"] },
    { id: "beam-free", name: "Beam Free", supportedFormats: ["openai"] },
    { id: "hy4-flash-free", name: "Hy4 flash Free", supportedFormats: ["openai"] },
    { id: "iceman-contributor-free", name: "Iceman Contributor Free", supportedFormats: ["openai"] },
    { id: "qwen4-max", name: "Qwen4 Max", supportedFormats: ["claude"] },
    { id: "qwen3.8-max", name: "Qwen3.8 Max", supportedFormats: ["claude"] },
    { id: "qwen3.8-flash", name: "Qwen3.8 Flash", supportedFormats: ["claude"] },
    { id: "qwen3.7-plus", name: "Qwen3.7 Plus", supportedFormats: ["claude"] },
    // Gemini generate-content protocol; no Go translator route here yet —
    // unknown formats fall back via unknownModelFormats.
    { id: "gemini-4-argon", name: "Gemini 4 Argon" },
  ],
};
