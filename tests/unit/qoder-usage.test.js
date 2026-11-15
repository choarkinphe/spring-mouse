import { describe, it, expect, vi } from "vitest";

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: vi.fn() }));
import { proxyAwareFetch } from "../../open-sse/utils/proxyFetch.js";
import { getQoderUsage } from "../../open-sse/services/usage/misc.js";
import { parseQuotaData, formatQuotaAmount, formatQuotaRemainingLabel, getRemainingPercentage, formatResetTime } from "../../src/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.js";
import { summarizeQuotaRows } from "../../src/app/(dashboard)/dashboard/providers/components/quotaSummary.js";

async function usage(body) {
  proxyAwareFetch.mockResolvedValueOnce(new Response(JSON.stringify(body)));
  return getQoderUsage("token");
}

describe("Qoder quota snapshot", () => {
  it("preserves zero credits and account-level exceeded status through the channel path", async () => {
    const result = await usage({ userQuota: { total: 0, used: 0, remaining: 0 }, isQuotaExceeded: true, expiresAt: Date.parse("9999-01-01T00:00:00Z") });
    const rows = parseQuotaData("qoder", result);
    const [{ quota }] = summarizeQuotaRows(rows);
    expect(rows).toHaveLength(1);
    expect(quota.isQuotaExceeded).toBe(true);
    expect(formatQuotaAmount(quota)).toBe("0 / 0 credits");
    expect(formatQuotaRemainingLabel(quota)).toBe("余量 0 credits");
    expect(getRemainingPercentage(quota)).toBe(0);
    expect(result.quotas.user.resetAt).toBe("9999-01-01T00:00:00.000Z");
    expect(quota.resetAt).toBeNull();
    expect(formatResetTime(quota.resetAt)).toBe("-");
  });

  it.each([false, undefined, null, "false"])("does not infer exceeded from %s", async (flag) => {
    const result = await usage({ userQuota: { total: 1000, used: 100, remaining: 348 }, isQuotaExceeded: flag });
    expect(result.isQuotaExceeded).toBe(flag === false ? false : null);
    const [row] = parseQuotaData("qoder", result);
    expect(formatQuotaRemainingLabel(row)).toBe("余量 348 credits");
    expect(getRemainingPercentage(row)).toBe(90);
  });

  it("keeps international plan and add-on balances: 300 + 100 = 400 credits", async () => {
    const result = await usage({ userQuota: { total: 300, used: 0, remaining: 300 },
      addOnQuota: { total: 100, used: 0, remaining: 100 }, expiresAt: 1794972137632 });
    expect(result.quotas.addOn).toMatchObject({ total: 100, used: 0, remaining: 100, unit: "credits", resetAt: null });
    const rows = parseQuotaData("qoder", result);
    expect(rows).toHaveLength(2);
    expect(rows.reduce((sum, row) => sum + row.total, 0)).toBe(400);
    expect(rows.reduce((sum, row) => sum + row.absoluteRemaining, 0)).toBe(400);
    expect(rows[1].name).toBe("附加积分");
    expect(formatQuotaRemainingLabel(rows[1])).toBe("余量 100 credits");
  });

  it("preserves zero add-on balances and infers consumption without sharing plan expiry", async () => {
    const result = await usage({ userQuota: { total: 300, used: 25, remaining: 275 },
      add_on_quota: { cap: "100", remaining: "0" }, expiresAt: 1794972137632 });
    expect(result.quotas.addOn).toEqual({ total: 100, remaining: 0, used: 100, unit: "credits", resetAt: null });
    const rows = parseQuotaData("qoder", result);
    expect(rows.reduce((sum, row) => sum + row.absoluteRemaining, 0)).toBe(275);
  });

  it("does not invent missing add-on amounts or duplicate its package detail", async () => {
    const result = await usage({ userQuota: { total: 300 }, addOnQuota: { total: 100 },
      dedicatedResourcePackages: [{ total: 100 }] });
    expect(result.quotas.addOn).toMatchObject({ total: 100, used: null, remaining: null });
    expect(Object.keys(result.quotas)).toEqual(["user", "organization", "addOn"]);
    const absent = await usage({ userQuota: { total: 300 }, addOnQuota: {} });
    expect(absent.quotas.addOn).toBeUndefined();
  });

  it("preserves dedicated-only campaign credits, restrictions and their own expiry", async () => {
    const expiry = Date.now() + 3 * 86400000;
    const result = await usage({ userQuota: { total: 0, used: 0, remaining: 0 }, isQuotaExceeded: true,
      expiresAt: Date.parse("9999-01-01T00:00:00Z"), dedicatedResourcePackages: [{
        id: "campaign", name: "act-20261112-658", total: "2000", remaining: "2000", available: true,
        status: "QUOTA_DETAIL_STATUS_ACTIVE", expiresAt: expiry,
        displayLabels: [
          { dimension: "title", valueI18n: { "zh-CN": "SOTA 专属积分" } },
          { dimension: "description", valueI18n: { "zh-CN": "选择 Sonus 模型时优先抵扣" } },
        ],
      }] });
    const rows = parseQuotaData("qoder", result);
    expect(rows).toHaveLength(2);
    const dedicated = rows[1];
    expect(dedicated).toMatchObject({ dedicated: true, displayName: "SOTA 专属积分 · act-20261112-658",
      description: "选择 Sonus 模型时优先抵扣", total: 2000, used: 0, absoluteRemaining: 2000,
      resetAt: new Date(expiry).toISOString(), isQuotaExceeded: true });
    expect(formatQuotaRemainingLabel(dedicated)).toBe("余量 2,000 credits");
    expect(getRemainingPercentage(dedicated)).toBe(100);
    expect(summarizeQuotaRows(rows)).toHaveLength(2);
  });

  it("omits unavailable, inactive, expired and malformed dedicated packages", async () => {
    const base = { total: 100, remaining: 100 };
    const result = await usage({ dedicatedResourcePackages: [null, [], {},
      { ...base, available: false }, { ...base, status: "QUOTA_DETAIL_STATUS_EXPIRED" },
      { ...base, expiresAt: Date.now() - 1000 },
    ] });
    expect(Object.keys(result.quotas)).toEqual(["user", "organization"]);
  });

  it("supports snake-case packages, stable row keys and unknown model restrictions", async () => {
    const result = await usage({ addOnQuota: {}, dedicated_resource_packages: [
      { id: "a", name: "same", cap: 100, remaining: 25 },
      { id: "b", name: "same", total: 50, used: 10, expires_at: "2030-01-01T00:00:00Z" },
    ] });
    expect(result.quotas["dedicated:a"]).toMatchObject({ used: 75, remaining: 25, dedicated: true });
    expect(result.quotas["dedicated:b"].resetAt).toBe("2030-01-01T00:00:00.000Z");
    expect(result.quotas["dedicated:a"].description).toContain("并非通用余额");
    expect(parseQuotaData("qoder", result).slice(1).map((row) => row.name)).toEqual(["dedicated:a", "dedicated:b"]);
  });

  it("reads CN usage from the regional endpoint and keeps credit amounts", async () => {
    proxyAwareFetch.mockResolvedValueOnce(new Response(JSON.stringify({ displayMode: "qoder", qoderUsage: {
      userQuota: { total: 100, remaining: 25 }, addOnQuota: { cap: 50, used: 5 },
    } })));
    const result = await getQoderUsage("cn-token", null, "qoder-cn");
    expect(proxyAwareFetch.mock.calls.at(-1)[0]).toBe("https://openapi.qoder.com.cn/sash/api/v2/me/usage");
    expect(result.quotas.user).toMatchObject({ total: 100, used: 75, remaining: 25 });
    expect(parseQuotaData("qoder-cn", result)).toHaveLength(2);
  });

  it.each(["qoder", "qoder-cn"])("suppresses only year 9999 for %s", (provider) => {
    const makeRows = (resetAt) => parseQuotaData(provider, { quotas: { user: { total: 10, used: 1, unit: "credits", resetAt } } });
    expect(makeRows("9999-12-31T00:00:00.000Z")[0].resetAt).toBeNull();
    expect(makeRows("2027-01-01T00:00:00.000Z")[0].resetAt).toBe("2027-01-01T00:00:00.000Z");
  });

  it("does not turn missing amounts into zero", async () => {
    const result = await usage({ userQuota: {} });
    const [row] = parseQuotaData("qoder", result);
    expect(formatQuotaAmount(row)).toBeNull();
    expect(formatQuotaRemainingLabel(row)).toBe("余量暂不可用");
  });
});
