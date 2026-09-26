import { withCodexReviewModels } from "../models/helpers.js";

export default {
  id: "codex",
  priority: 30,
  alias: "cx",
  uiAlias: "cx",
  display: {
    name: "OpenAI Codex",
    icon: "code",
    color: "#3B82F6",
    website: "https://chatgpt.com/codex",
    notice: {
      signupUrl: "https://chatgpt.com/codex",
    },
    deprecated: true,
    deprecationNotice: "RISK_NOTICE",
    kindNotice: {
      image: "Requires a ChatGPT Plus (or higher) account. Free accounts are not supported for image generation.",
    },
  },
  category: "oauth",
  thinkingConfig: {
    options: [
      "auto",
      "none",
      "low",
      "medium",
      "high",
    ],
    defaultMode: "auto",
  },
  transport: {
    baseUrl: "https://chatgpt.com/backend-api/codex/responses",
    format: "openai-responses",
    forceStream: true,
    // Byte-silence watchdog. A Codex account can accept a request, emit its
    // metadata frames, and then never send another byte — measured on
    // production, one account swallowed 40 requests in a day, each ending after
    // ~343s with pt=0 ct=0 (no output ever arrived). The default 360s is far too
    // late: the client in front of this gateway gives up first, so spring-mouse
    // was still holding the stream open long after the caller had gone, and the
    // caller saw a silent hang instead of an ended stream.
    //
    // 170s is chosen against both ends of the measured distribution:
    //   - below the client's 180s streaming idle timeout, so WE end the stream
    //     first and the caller learns the turn failed instead of waiting out its
    //     own watchdog;
    //   - above the slowest LEGITIMATE turn. Codex success TTFT has a real long
    //     tail (189 turns at 60-90s, 16 at 90-120s, 8 at 120-180s over 3 days),
    //     and those are genuine work — prompts of 184k-336k tokens whose first
    //     token simply takes a long time. The slowest measured was 165.7s, so a
    //     150s bound would abort real turns to catch a stall; 170s clears them
    //     while still firing well before the client gives up.
    stallTimeoutMs: 170000,
    headers: {
      originator: "codex_cli_rs",
      "User-Agent": "codex_cli_rs/0.136.0",
    },
    usage: {
      url: "https://chatgpt.com/backend-api/wham/usage",
      resetCreditsUrl: "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits",
      resetCreditsConsumeUrl: "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume",
    },
  },
  models: [
    { id: "gpt-5.6-sol", name: "GPT 5.6 Sol" },
    { id: "gpt-5.6-sol-review", name: "GPT 5.6 Sol Review", upstreamModelId: "gpt-5.6-sol", quotaFamily: "review" },
    { id: "gpt-5.6-terra", name: "GPT 5.6 Terra" },
    { id: "gpt-5.6-terra-review", name: "GPT 5.6 Terra Review", upstreamModelId: "gpt-5.6-terra", quotaFamily: "review" },
    { id: "gpt-5.6-luna", name: "GPT 5.6 Luna" },
    { id: "gpt-5.6-luna-review", name: "GPT 5.6 Luna Review", upstreamModelId: "gpt-5.6-luna", quotaFamily: "review" },
    { id: "gpt-5.5", name: "GPT 5.5" },
    { id: "gpt-5.5-review", name: "GPT 5.5 Review", upstreamModelId: "gpt-5.5", quotaFamily: "review" },
    { id: "gpt-5.4", name: "GPT 5.4" },
    { id: "gpt-5.4-review", name: "GPT 5.4 Review", upstreamModelId: "gpt-5.4", quotaFamily: "review" },
    { id: "gpt-5.4-mini", name: "GPT 5.4 Mini" },
    { id: "gpt-5.4-mini-review", name: "GPT 5.4 Mini Review", upstreamModelId: "gpt-5.4-mini", quotaFamily: "review" },
    { id: "gpt-5.3-codex-spark", name: "GPT 5.3 Codex Spark" },
    { id: "gpt-5.3-codex-spark-review", name: "GPT 5.3 Codex Spark Review", upstreamModelId: "gpt-5.3-codex-spark", quotaFamily: "review" },
    { id: "gpt-5.5-image", name: "GPT 5.5 Image", capabilities: ["text2img","edit"], params: ["size","quality","background","image_detail","output_format"], kind: "image" },
    { id: "gpt-5.4-image", name: "GPT 5.4 Image", capabilities: ["text2img","edit"], params: ["size","quality","background","image_detail","output_format"], kind: "image" },
    { id: "gpt-5.3-image", name: "GPT 5.3 Image", capabilities: ["text2img","edit"], params: ["size","quality","background","image_detail","output_format"], kind: "image" },
  ],
  serviceKinds: ["llm","image"],
  oauth: {
    clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
    authorizeUrl: "https://auth.openai.com/oauth/authorize",
    tokenUrl: "https://auth.openai.com/oauth/token",
    scope: "openid profile email offline_access",
    codeChallengeMethod: "S256",
    fixedPort: 1455,
    callbackPath: "/auth/callback",
    extraParams: {
      id_token_add_organizations: "true",
      codex_cli_simplified_flow: "true",
      originator: "codex_cli_rs",
    },
    refreshLeadMs: 432000000,
    refresh: {
      encoding: "form",
      scope: "openid profile email offline_access",
    },
    maxRefreshAgeMs: 691200000,
    trackRefreshAt: true,
  },
  features: {
    usage: true,
  },
};
