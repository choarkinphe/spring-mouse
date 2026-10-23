// WorkBuddy CN daily rewards protocol, verified against yetone/magpie
// internal/provider/workbuddy_checkin.go at 87d703c5 (protocol reference only).
// CN only; the international service has no activity.
export const CODEBUDDY_CHECKIN = {
  provider: "codebuddy-cn",
  origin: "https://copilot.tencent.com",
  statusPath: "/v2/billing/meter/checkin-activity-status",
  claimPath: "/v2/billing/meter/daily-checkin",
  summaryPath: "/billing/meter/get-user-resource-summary",
  userAgent: "WorkBuddy/5.5.6",
  version: "5.5.6",
  timeoutMs: 20_000,
  leaseMs: 5 * 60 * 1000,
  retryMs: 60 * 60 * 1000,
};

export function supportsCodeBuddyCheckin(connection) {
  return connection?.provider === CODEBUDDY_CHECKIN.provider && connection?.authType === "oauth";
}

export function codeBuddyCheckinDate(now = Date.now()) {
  return new Date(now + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}
