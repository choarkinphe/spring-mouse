import { DEVIN } from "../../config/devin.js";

// Only parse Devin's explicit reset sentence, not arbitrary clock times in an
// error. The UTC clock is precise; the relative duration is usually rounded.
// Weekly quota exhaustion names no reset time, so it cannot be scheduled like a
// rate-limit cooldown; callers apply their own bounded lock instead of the
// shared 429 backoff.
export function isDevinQuotaExhausted(message) {
  if (message == null) return false;
  // Error text reaches this point as a bare string or as a JSON body.
  return DEVIN.weeklyQuotaPattern.test(typeof message === "string" ? message : JSON.stringify(message));
}

export function parseDevinQuotaReset(message, now = Date.now()) {
  if (typeof message !== "string" || !Number.isFinite(now)) return null;
  const match = message.match(DEVIN.quotaResetPattern);
  if (!match) return null;
  const [, durationText, hour, minute] = match;
  let durationMs = null;
  if (durationText) {
    const units = { hour: 3_600_000, minute: 60_000, second: 1000 };
    const parts = [...durationText.matchAll(/(\d+)\s*(hours?|minutes?|seconds?)\b/gi)];
    const remainder = durationText.replace(/\d+\s*(?:hours?|minutes?|seconds?)\b/gi, "").replace(/\band\b|[,\s]/gi, "");
    if (parts.length && !remainder) {
      durationMs = parts.reduce((sum, [, count, unit]) => sum + Number(count) * units[unit.toLowerCase().replace(/s$/, "")], 0);
    }
    if (!(durationMs > 0 && durationMs <= DEVIN.maxQuotaCooldownMs)) return null;
  }
  if (hour !== undefined) {
    if (Number(hour) > 23 || Number(minute) > 59) return null;
    // Relative duration disambiguates the day at midnight without interpreting
    // a stale, clock-only error as a fresh 24-hour lock.
    const reference = new Date(now + (durationMs || 0));
    reference.setUTCHours(Number(hour), Number(minute), 0, 0);
    const reset = reference.getTime();
    if (reset > now && reset - now <= DEVIN.maxQuotaCooldownMs) return reset;
    return null;
  }
  return durationMs ? now + durationMs : null;
}
