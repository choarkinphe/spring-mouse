import { describe, expect, it } from "vitest";
import {
  formatQuotaAmount,
  formatQuotaRemainingLabel,
  formatQuotaBalance,
  formatRemainingQuota,
  getRemainingPercentage,
  parseQuotaData,
} from "@/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.js";

describe("quota amount labels", () => {
  it.each([
    ["percent", { used: 23, total: 100, unit: "%" }, "23% / 100%"],
    ["fractional percent", { used: 12.5, total: 100, unit: " % " }, "12.5% / 100%"],
    ["credits", { used: 1250, total: 5000, unit: "credits" }, "1,250 / 5,000 credits"],
    ["points", { used: 1000, total: 1000, unit: "积分" }, "1,000 / 1,000 积分"],
    ["unknown unit", { used: 20, total: 100, unit: "widgets" }, "20 / 100 widgets"],
    ["unitless is not percent or requests", { used: 20, total: 100 }, "20 / 100"],
    ["zero usage", { used: 0, total: 100, unit: "%" }, "0% / 100%"],
    ["numeric strings", { used: "2.5", total: "100", unit: "credits" }, "2.5 / 100 credits"],
    ["unlimited legacy count", { used: 2, total: 0, unit: "credits" }, "2 / ∞ credits"],
    ["explicit unlimited", { used: 2, total: null, unlimited: true }, "2 / ∞"],
    ["balance takes precedence", { used: 0, total: 100, balance: 12.5, currency: "USD" }, "$12.50"],
    ["currency pair", { used: 1.25, total: 5, currency: "USD" }, "$1.25 / $5.00"],
    ["missing row", undefined, null],
    ["null row", null, null],
    ["empty row", {}, null],
    ["missing used", { total: 100 }, null],
    ["null used", { used: null, total: 100 }, null],
    ["null total", { used: 0, total: null }, null],
    ["blank used", { used: " ", total: 100 }, null],
    ["invalid used", { used: "bad", total: 100 }, null],
    ["infinite total", { used: 2, total: Infinity }, null],
  ])("formats %s", (_name, quota, expected) => {
    expect(formatQuotaAmount(quota)).toBe(expected);
  });
});

describe("remaining quota labels", () => {
  it.each([
    ["Codex remaining percentage", { used: 20, total: 100, remaining: 80, unit: "%" }, "80%"],
    ["explicit remaining wins", { used: 20, total: 100, remaining: 75, unit: "%" }, "75%"],
    ["percentage-only", { remainingPercentage: 43.5 }, "44%"],
    ["percentage from used", { used: 20, total: 100, unit: "%" }, "80%"],
    ["unitless ratio", { used: 20, total: 100 }, "80%"],
    ["credits ignore absolute remaining field", { used: 100, total: 1000, remaining: 900, unit: "credits" }, "900 credits"],
    ["points", { used: 200, total: 1000, unit: "积分" }, "800 积分"],
    ["unknown unit", { used: 20, total: 100, unit: "widgets" }, "80 widgets"],
    ["exhausted", { used: 120, total: 100, unit: "credits" }, "0 credits"],
    ["currency balance", { balance: 12.5, currency: "USD" }, "$12.50"],
    ["currency pair", { used: 1.25, total: 5, currency: "USD" }, "$3.75"],
    ["null remaining is absent", { used: 20, total: 100, remaining: null }, "80%"],
    ["missing row", undefined, null],
    ["null used", { used: null, total: 100, unit: "credits" }, null],
    ["missing total", { used: 20 }, null],
    ["unbounded", { used: 20, total: 0 }, null],
  ])("formats %s", (_name, quota, expected) => {
    expect(formatRemainingQuota(quota)).toBe(expected);
  });
});

describe("remaining-first quota labels", () => {
  it.each([
    [{ used: 275.36, total: 500, unit: "积分" }, "余量 224.64 积分"],
    [{ used: 500, total: 500, unit: "积分" }, "余量 0 积分"],
    [{ used: 0, total: 100, unit: "%" }, "余量 100%"],
    [{ used: 27, total: 100, unit: "%" }, "余量 73%"],
    [{ used: 12.5, total: 500, unit: "credits" }, "余量 487.5 credits"],
    [{ balance: 42.5, currency: "CNY" }, "余额 ¥42.50"],
    [undefined, "余量暂不可用"],
  ])("shows only remaining amount for %j", (quota, expected) => {
    expect(formatQuotaRemainingLabel(quota)).toBe(expected);
  });
});

describe("quota currency balances", () => {
  it.each([
    ["missing balance", {}, null],
    ["null balance", { balance: null, currency: "USD" }, null],
    ["blank balance", { balance: "", currency: "USD" }, null],
    ["zero balance", { balance: 0, currency: "USD" }, "$0.00"],
    ["CNY balance", { balance: "28.75", currency: "cny" }, "¥28.75"],
    ["unknown currency", { balance: 12.5, currency: "credits" }, "12.5 CREDITS"],
    ["no currency", { balance: 12.5 }, "12.5"],
  ])("formats %s", (_name, quota, expected) => {
    expect(formatQuotaBalance(quota)).toBe(expected);
  });
});

describe("normalized provider quota units", () => {
  it("marks old Codex percentage payloads and preserves remaining math", () => {
    const [quota] = parseQuotaData("codex", { quotas: { session: { used: 23, total: 100, remaining: 77 } } });
    expect(quota.unit).toBe("%");
    expect(formatQuotaAmount(quota)).toBe("23% / 100%");
    expect(formatRemainingQuota(quota)).toBe("77%");
    expect(getRemainingPercentage(quota)).toBe(77);
  });

  it.each([
    [604800, "周额度"], [18000, "5 小时额度"], [86400, "24 小时额度"], [3600, "1 小时额度"],
    [undefined, "主额度窗口"],
  ])("labels primary windows by actual duration %s without changing their identity", (windowSeconds, displayName) => {
    const [quota] = parseQuotaData("codex", { quotas: { session: { used: 0, total: 100, remaining: 100, windowSeconds } } });
    expect(quota).toMatchObject({ name: "session", displayName });
    expect(formatRemainingQuota(quota)).toBe("100%");
  });

  it("preserves explicit units without guessing from total=100", () => {
    const [quota] = parseQuotaData("codex", { quotas: { session: { used: 20, total: 100, unit: "credits" } } });
    expect(formatQuotaAmount(quota)).toBe("20 / 100 credits");
  });

  it.each([
    ["qoder", "user", "credits", "1,000 / 5,000 credits", "4,000 credits"],
    ["codebuddy-cn", "Monthly", undefined, "1,000 / 5,000 积分", "4,000 积分"],
    ["codebuddy-intl", "Monthly", undefined, "1,000 / 5,000 积分", "4,000 积分"],
    ["custom-provider", "bucket", "widgets", "1,000 / 5,000 widgets", "4,000 widgets"],
  ])("preserves %s counted units", (provider, name, unit, amount, remaining) => {
    const [quota] = parseQuotaData(provider, { quotas: { [name]: { used: 1000, total: 5000, remaining: 4000, unit } } });
    expect(formatQuotaAmount(quota)).toBe(amount);
    expect(formatRemainingQuota(quota)).toBe(remaining);
    expect(getRemainingPercentage(quota)).toBe(80);
  });

  it("keeps DeepSeek money balances distinct from quota counts", () => {
    const [quota] = parseQuotaData("deepseek", { quotas: { "Balance (CNY)": { used: 0, total: 28.75, balance: 28.75, currency: "CNY", remainingPercentage: 100 } } });
    expect(formatQuotaAmount(quota)).toBe("¥28.75");
    expect(formatRemainingQuota(quota)).toBe("¥28.75");
    expect(getRemainingPercentage(quota)).toBe(100);
  });

  it("does not invert Vercel's remaining balance stored in used", () => {
    const quotas = parseQuotaData("vercel-ai-gateway", { quotas: {
      "Used (USD)": { used: 1.25, total: 0, remainingPercentage: 100 },
      "Remaining (USD)": { used: 3.75, total: 5, remainingPercentage: 75 },
    } });
    const remaining = quotas.find((quota) => quota.name === "Remaining (USD)");
    expect(remaining.used).toBe(3.75);
    expect(remaining.total).toBe(5);
    expect(formatQuotaAmount(remaining)).toBe("$3.75");
    expect(formatRemainingQuota(remaining)).toBe("$3.75");
    expect(getRemainingPercentage(remaining)).toBe(75);
    expect(formatQuotaAmount(quotas[0])).toBe("$1.25 / ∞");
  });

  it("keeps OpenCode Go display names and explicit percentage units", () => {
    const [quota] = parseQuotaData("opencode-go", { quotas: { rolling: {
      displayName: "5-hour", used: 23, total: 100, remaining: 77, unit: "%", resetAt: "2026-10-20T12:00:00Z",
    } } });
    expect(quota).toMatchObject({ name: "5-hour", unit: "%", remaining: 77, resetAt: "2026-10-20T12:00:00Z" });
    expect(formatQuotaAmount(quota)).toBe("23% / 100%");
    expect(formatRemainingQuota(quota)).toBe("77%");
  });
});
