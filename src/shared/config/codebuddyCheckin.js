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

export function codeBuddyCheckinDate(now = Date.now()) {
  return new Date(now + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}
