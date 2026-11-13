import { describe, expect, it } from "vitest";
import { parseDevinQuotaReset, isDevinQuotaExhausted } from "../../open-sse/shared/devin/rateLimit.js";

const now = Date.parse("2026-11-13T08:14:00Z");
const message = "Reached free model rate limit. Upgrade to Max for higher limits, or switch to a different model. Your limit will reset in 1 hour 45 minutes (at 10:01 UTC).";

describe("Devin quota reset parsing", () => {
  it("prefers the precise UTC clock over the rounded duration", () => {
    expect(parseDevinQuotaReset(message, now)).toBe(Date.parse("2026-11-13T10:01:00Z"));
  });

  it.each([
    ["Your limit will reset in 2 hours.", 7_200_000],
    ["Your limit will reset in 1 hour and 2 minutes.", 3_720_000],
    ["Your limit will reset in 45 minutes 30 seconds.", 2_730_000],
    ["Your limit will reset in 30 seconds.", 30_000],
    ["Your limit will reset at 10:01 UTC.", 6_420_000],
  ])("parses %s", (text, delay) => {
    expect(parseDevinQuotaReset(text, now)).toBe(now + delay);
  });

  it("uses the duration to resolve a UTC clock crossing midnight", () => {
    const start = Date.parse("2026-11-13T23:40:00Z");
    expect(parseDevinQuotaReset("Your limit will reset in 30 minutes (at 00:10 UTC).", start))
      .toBe(Date.parse("2026-11-14T00:10:00Z"));
  });

  it.each([
    "quota reached", "Your limit will reset at 07:00 UTC.",
    "Your limit will reset in 0 seconds.", "Your limit will reset in -1 hour.",
    "Your limit will reset in 999 hours.", "Your limit will reset at 25:90 UTC.",
    "Your limit will reset in a while.", "Retry at 10:01 UTC.",
    null, {},
  ])("does not invent an expiry from invalid or stale text: %j", text => {
    expect(parseDevinQuotaReset(text, now)).toBeNull();
  });
});

describe("Devin weekly quota exhaustion detection", () => {
  const exhausted = "Devin upstream error (failed_precondition): Your weekly usage quota has been exhausted. Visit https://app.devin.ai/settings/usage to purchase on-demand usage or turn on auto-reload.";
  it("recognizes the upstream weekly-quota sentence", () => {
    expect(isDevinQuotaExhausted(exhausted)).toBe(true);
  });
  it.each([
    message,
    "Reached free model rate limit. Please switch to a different model.",
    "Devin upstream error (invalid_argument): There is an issue with this request, please try a different model.",
    "daily quota has been exhausted",
    null, {}, 429,
  ])("does not match other errors: %j", text => {
    expect(isDevinQuotaExhausted(text)).toBe(false);
  });
});
