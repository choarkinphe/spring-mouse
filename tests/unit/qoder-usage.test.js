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
