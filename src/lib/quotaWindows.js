// Shared rolling-window definitions for every token quota (whole key, and each
// combo member). Kept dependency-free so `apiKeyQuota.js` and
// `memberQuota.js` can both import it without a cycle.
//
// `resetAt` is a scheduled boundary: the key stores the next boundary for each
// window, and every counter key embeds it, so advancing the boundary ("the
// window rolled over") starts a fresh counter instead of deleting the old one.
export const QUOTA_WINDOWS = [
  { id: "fiveHour", label: "5 小时", durationMs: 5 * 60 * 60 * 1000 },
  { id: "weekly", label: "近 7 天", durationMs: 7 * 24 * 60 * 60 * 1000 },
];

export const QUOTA_RESET_FIELDS = {
  fiveHour: "fiveHourQuotaResetAt",
  weekly: "weeklyQuotaResetAt",
};

// Rule field names. Kept beside the windows so a new window cannot be added
// without deciding how it is configured and where its reset lives.
export const QUOTA_LIMIT_FIELDS = {
  fiveHour: "fiveHourTokenLimitM",
  weekly: "weeklyTokenLimitM",
};

/**
 * The next boundary strictly after `nowMs`, preserving the stored cadence.
 * A missing or malformed value starts a fresh window from now.
 */
export function nextScheduledReset(value, durationMs, nowMs) {
  let nextMs = value ? new Date(value).getTime() : Number.NaN;
  if (!Number.isFinite(nextMs)) return nowMs + durationMs;
  while (nextMs <= nowMs) nextMs += durationMs;
  return nextMs;
}

/** Start of the rolling interval that ends at `resetAt`. */
export function windowStartIso(resetAt, durationMs) {
  return new Date(new Date(resetAt).getTime() - durationMs).toISOString();
}
