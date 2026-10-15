import { CODEBUDDY_RATE_LIMIT } from "../config/errorConfig.js";

// Both regional gateways use the same quota/throttle error envelope.
export function applyCodeBuddyRateLimit(parsed, response, bodyText) {
  if (response.status !== 429) return parsed;
  try {
    const error = JSON.parse(bodyText);
    if (Number(error.code) === CODEBUDDY_RATE_LIMIT.throttleCode) {
      parsed.retryAfterMs = CODEBUDDY_RATE_LIMIT.retryAfterMs;
    } else if (Number(error.code) === CODEBUDDY_RATE_LIMIT.quotaCode) {
      // The upstream reset is a wall-clock time with an explicit UTC offset;
      // never interpret it in the Spring host's local timezone.
      const reset = String(error.msg || "").match(/reset at (\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) UTC([+-])(\d{1,2})(?::(\d{2}))?\b/);
      if (reset) {
        const [, date, time, sign, hours, minutes = "00"] = reset;
        const resetsAtMs = Date.parse(`${date}T${time}${sign}${hours.padStart(2, "0")}:${minutes}`);
        if (Number.isFinite(resetsAtMs) && resetsAtMs > Date.now()) parsed.resetsAtMs = resetsAtMs;
      }
    }
  } catch { /* Preserve generic handling for non-JSON errors. */ }
  return parsed;
}
