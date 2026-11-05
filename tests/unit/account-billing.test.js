import { describe, expect, it } from "vitest";
import {
  BILLING_MODES, BILLING_MODE_LABELS, isBillingMode, resolveAccountBillingMode,
  normalizeBillingEntry, normalizeBillingRange, normalizeAccountTokens, summarizeBillingEntries,
} from "../../src/shared/utils/accountBilling.js";

const entry = {
  amount: 30, currency: "USD", paidAt: "2026-01-01T00:00:00Z",
  startAt: "2026-01-01T00:00:00Z", endAt: "2026-01-31T00:00:00Z", note: "Monthly plan",
};

describe("account billing pure utilities", () => {
  it("resolves explicit modes before provider and auth defaults", () => {
    for (const mode of BILLING_MODES) {
      expect(isBillingMode(mode)).toBe(true);
      expect(BILLING_MODE_LABELS[mode]).toBeTruthy();
      expect(resolveAccountBillingMode({ provider: "qoder", authType: "oauth", billingMode: mode })).toBe(mode);
    }
    expect(isBillingMode("automatic")).toBe(false);
    for (const provider of ["qoder", "qoder-cn", "workbuddy", "workbuddy-ai", "kiro", "codex", "cursor", "github", "glm", "glm-cn", "alicode", "alicode-intl", "qianwen-token-plan", "minimax"]) {
      expect(resolveAccountBillingMode({ provider, authType: "apikey" })).toBe("subscription");
    }
    expect(resolveAccountBillingMode({ provider: "custom", authType: "oauth" })).toBe("subscription");
    expect(resolveAccountBillingMode({ provider: "openai", authType: "apikey" })).toBe("metered");
    expect(resolveAccountBillingMode({ provider: "claude", authType: "apikey" })).toBe("metered");
    expect(resolveAccountBillingMode({ provider: "claude", authType: "oauth" })).toBe("subscription");
    expect(resolveAccountBillingMode({ provider: "custom", authType: "apikey" })).toBe("unknown");
    expect(resolveAccountBillingMode()).toBe("unknown");
  });

  it("normalizes timestamps and optional UUID without trusting arbitrary fields", () => {
    const normalized = normalizeBillingEntry({ ...entry, id: "9BD3A2E2-9731-4B16-A16E-0ABF56D2852A", amount: 0, startAt: "2026-01-01T08:00:00+08:00", accessToken: "secret" });
    expect(normalized).toEqual({ ...entry, amount: 0, id: "9bd3a2e2-9731-4b16-a16e-0abf56d2852a", paidAt: "2026-01-01T00:00:00.000Z", startAt: "2026-01-01T00:00:00.000Z", endAt: "2026-01-31T00:00:00.000Z" });
    expect(normalizeBillingEntry({ ...entry, note: undefined }).note).toBe("");
  });

  it.each([NaN, Infinity, -Infinity, -1, "30", null, undefined])("rejects invalid amount %s", (amount) => {
    expect(() => normalizeBillingEntry({ ...entry, amount })).toThrow(/amount/);
  });

  it.each(["usd", "US", "USDD", "XYZ", "BTC", "", null])("rejects unsupported currency %s", (currency) => {
    expect(() => normalizeBillingEntry({ ...entry, currency })).toThrow(/currency/);
  });

  it.each(["2026-02-30T00:00:00Z", "2026-01-01", "yesterday", "2026-01-01T00:00:00", "2026-01-01T24:00:00Z", "2026-01-01T00:60:00Z", "2026-01-01T00:00:00+24:00", "2026-13-01T00:00:00Z"]) ("rejects invalid date %s", (paidAt) => {
    expect(() => normalizeBillingEntry({ ...entry, paidAt })).toThrow(/paidAt/);
  });

  it("requires ordered service dates, paidAt, note bounds, and valid id", () => {
    expect(() => normalizeBillingEntry({ ...entry, paidAt: undefined })).toThrow();
    expect(() => normalizeBillingEntry({ ...entry, endAt: entry.startAt })).toThrow(/before/);
    expect(() => normalizeBillingEntry({ ...entry, startAt: entry.endAt, endAt: entry.startAt })).toThrow(/before/);
    expect(() => normalizeBillingEntry({ ...entry, note: "a".repeat(2001) })).toThrow(/note/);
    expect(() => normalizeBillingEntry({ ...entry, id: "1" })).toThrow(/UUID/);
    expect(() => normalizeBillingRange(entry.endAt, entry.startAt)).toThrow(/before/);
    expect(() => normalizeBillingRange(null, entry.endAt)).toThrow();
  });

  it("sums payment dates half-open and accrues overlap proportionally without currency exchange", () => {
    const entries = [normalizeBillingEntry(entry), normalizeBillingEntry({ ...entry, amount: 300, currency: "CNY", paidAt: "2026-01-31T00:00:00Z" })];
    const first = summarizeBillingEntries(entries, entry.startAt, "2026-01-16T00:00:00Z");
    expect(first.subscriptionPaid).toEqual({ USD: 30 });
    expect(first.subscriptionAccrued).toEqual({ USD: 15, CNY: 150 });
    const second = summarizeBillingEntries(entries, "2026-01-16T00:00:00Z", entry.endAt);
    expect(second.subscriptionPaid).toEqual({});
    expect(second.subscriptionAccrued).toEqual({ USD: 15, CNY: 150 });
    const after = summarizeBillingEntries(entries, entry.endAt, "2026-02-01T00:00:00Z");
    expect(after.subscriptionPaid).toEqual({ CNY: 300 });
    expect(after.subscriptionAccrued).toEqual({});
    expect(after.entries).toHaveLength(1);
  });

  it("does not add cache or reasoning subsets twice", () => {
    expect(normalizeAccountTokens({ prompt_tokens: 100, completion_tokens: 20, cached_tokens: 40, cache_creation_input_tokens: 10, reasoning_tokens: 5 })).toEqual({ inputTokens: 100, outputTokens: 20, cachedTokens: 40, cacheCreationTokens: 10, totalTokens: 120 });
    expect(normalizeAccountTokens({ input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 30 }).totalTokens).toBe(120);
    expect(normalizeAccountTokens({ prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 30 } }).cachedTokens).toBe(30);
    expect(normalizeAccountTokens({}, { promptTokens: 50, completionTokens: 5 }).totalTokens).toBe(55);
  });
});
