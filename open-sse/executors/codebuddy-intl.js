import { DefaultExecutor } from "./default.js";
import { CODEBUDDY_RATE_LIMIT } from "../config/errorConfig.js";

/**
 * CodeBuddyIntlExecutor — talks to https://www.codebuddy.ai/v2/chat/completions
 *
 * Same OpenAI-compatible-but-stream-only gateway behavior as codebuddy-cn:
 * non-stream requests are rejected, and reasoning is surfaced only when the
 * request carries the IDE's OpenAI-style reasoning params. Force stream and
 * mirror reasoning_summary exactly like CodeBuddyExecutor.
 */
export class CodeBuddyIntlExecutor extends DefaultExecutor {
  constructor() {
    super("codebuddy-intl");
  }

  parseError(response, bodyText) {
    const parsed = super.parseError(response, bodyText);
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

  transformRequest(model, body, stream, credentials) {
    const transformed = super.transformRequest(model, body, stream, credentials);
    transformed.stream = true;

    const eff = transformed.reasoning_effort;
    if (eff === "none" || eff === "off") {
      delete transformed.reasoning_effort;
    } else if (eff) {
      transformed.reasoning_summary = "auto";
    }

    // CodeBuddy rejects plain OpenAI shape (11101 invalid request): needs a
    // leading system prompt + user content as typed blocks, not a bare string.
    const source = Array.isArray(transformed.messages) ? transformed.messages : [];
    transformed.messages = [{ role: "system", content: "You are CodeBuddy Code." }];
    for (const message of source) {
      if (!message || typeof message !== "object" || ["system", "developer"].includes(message.role)) continue;
      if (message.role === "user" && typeof message.content === "string") {
        transformed.messages.push({ ...message, content: [{ type: "text", text: message.content }] });
      } else {
        transformed.messages.push({ ...message });
      }
    }

    return transformed;
  }
}

export default CodeBuddyIntlExecutor;
