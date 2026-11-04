// WorkBuddy CN daily rewards protocol, verified against yetone/magpie
// internal/provider/workbuddy_checkin.go at 87d703c5 (protocol reference only).
// Both the legacy `codebuddy-cn` id and the new `workbuddy` id are China
// service accounts. The international sites (codebuddy-intl, workbuddy-ai)
// have no check-in activity and must stay excluded.
export const CODEBUDDY_CHECKIN = {
  providers: ["codebuddy-cn", "workbuddy"],
  // Every supported provider has its own entry; never derive a host from
  // connection data or fall back to a first entry.
  sites: {
    "codebuddy-cn": { origin: "https://copilot.tencent.com", domain: "copilot.tencent.com" },
    workbuddy: { origin: "https://copilot.tencent.com", domain: "copilot.tencent.com" },
  },
  statusPath: "/v2/billing/meter/checkin-activity-status",
  claimPath: "/v2/billing/meter/daily-checkin",
  summaryPath: "/billing/meter/get-user-resource-summary",
  unsupportedMessage: "仅支持 WorkBuddy 国内版 OAuth 账号签到",
  userAgent: "WorkBuddy/5.5.6",
  version: "5.5.6",
  timeoutMs: 20_000,
  leaseMs: 5 * 60 * 1000,
  retryMs: 60 * 60 * 1000,
};

export function isCodeBuddyCheckinProvider(provider) {
  return CODEBUDDY_CHECKIN.providers.includes(provider);
}

export function checkinSite(provider) {
  const site = isCodeBuddyCheckinProvider(provider) ? CODEBUDDY_CHECKIN.sites[provider] : undefined;
  if (!site) throw new Error(`Unsupported check-in provider: ${provider}`);
  return site;
}

export function supportsCodeBuddyCheckin(connection) {
  return isCodeBuddyCheckinProvider(connection?.provider) && connection?.authType === "oauth";
}

export function isQoderCheckinProvider(provider) {
  return provider === "qoder" || provider === "qoder-cn";
}

// Retain the WorkBuddy-specific predicate for its OAuth contract; use this rule
// at the shared UI/API/scheduler boundaries. Qoder PATs exchange to job tokens.
export function supportsDailyCheckin(connection) {
  return supportsCodeBuddyCheckin(connection) || (isQoderCheckinProvider(connection?.provider)
    && ["oauth", "apikey"].includes(connection?.authType));
}

// International rewards use the official native device identity. Eligibility
// remains the server's decision; no client identity or VM status is spoofed.
export const QODER_GLOBAL_REWARDS = {
  guideUrl: "https://docs.qoder.com/events/100credits",
  message: "通过官方原生组件提供当前设备身份，按官方活动资格领取；不会伪造设备或绕过领取限制。",
};

export function supportsAutomaticCheckin(connection) {
  return supportsDailyCheckin(connection);
}

export function currentDailyCheckinState(state = {}, provider) {
  if (provider !== "qoder") return state;
  if (state.status === "desktop_required" || state.status === "own_app"
    && typeof state.message === "string" && (state.message.startsWith("Qoder 国际版签到需要官方设备身份"))) {
    return { ...state, status: "recheck", message: "原生领取流程已更新，待重新查询官方活动", terminalDate: null, retryAfter: 0, lastAttemptAt: null };
  }
  return state;
}

export const DAILY_CHECKIN_UNSUPPORTED = "仅支持 WorkBuddy 国内版 OAuth 或 Qoder / Qoder CN OAuth、PAT 账号签到";

export function codeBuddyCheckinDate(now = Date.now()) {
  return new Date(now + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}
