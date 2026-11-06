import { describe, expect, it, vi } from "vitest";
import { fetchDevinUserStatus, getDevinIdentity, getDevinUsage, parseDevinUsage } from "open-sse/services/usage/devin.js";

// Fixtures transcribed from upstream packages/devin/usage.test.mjs and
// identity.test.mjs at magpie-community/plugins commit
// 749e9dd12a5401cc11a701b7598c7ce32fcd7259 (MIT). These are upstream test
// fixtures shaped after live account responses, not captured credentials.
const status = (plan = {}) => ({ userStatus: { planStatus: {
  planInfo: { planName: "Teams", teamsTier: "TEAMS_TIER_DEVIN_TEAMS", billingStrategy: "BILLING_STRATEGY_QUOTA", monthlyPromptCredits: -1, isDevin: true },
  planStart: "2026-09-26T21:45:55Z", planEnd: "2026-10-26T21:45:55Z",
  availablePromptCredits: -1, dailyQuotaRemainingPercent: 100,
  weeklyQuotaRemainingPercent: 99, overageBalanceMicros: "46807746",
  dailyQuotaResetAtUnix: "1790841600", weeklyQuotaResetAtUnix: "1791100800",
  ...plan,
} } });
const orgStatus = (orgName, orgId, teamId) => ({ userStatus: {
  name: "sky", email: "m@x.dev", teamId, teamsTier: "TEAMS_TIER_DEVIN_MAX",
  planStatus: { planInfo: { planName: "Max", devinInfo: { orgId, accountDisplayName: orgName } } },
} });

function fixtureFetch(data, responseStatus = 200) {
  return vi.fn(async () => new Response(JSON.stringify(data), { status: responseStatus, headers: { "Content-Type": "application/json" } }));
}

describe("Devin GetUserStatus pinned upstream contract", () => {
  it("sends exact JSON metadata contract and per-account proxy options", async () => {
    const fetchFn = fixtureFetch(status());
    const proxyOptions = { proxyEnabled: true };
    const u = await fetchDevinUserStatus({ accessToken: "devin-key" }, { fetchFn, proxyOptions });
    expect(u).toEqual(status().userStatus);
    const [url, options, proxy] = fetchFn.mock.calls[0];
    expect(url).toBe("https://server.codeium.com/exa.seat_management_pb.SeatManagementService/GetUserStatus");
    expect(options).toMatchObject({ method: "POST", headers: { "Content-Type": "application/json", "Connect-Protocol-Version": "1" }, redirect: "error", cache: "no-store" });
    expect(JSON.parse(options.body)).toEqual({ metadata: { ideName: "devin-cli", ideVersion: "3000.11.3", extensionName: "devin-cli", extensionVersion: "3000.11.3", apiKey: "devin-key", locale: "en", os: process.platform === "win32" ? "windows" : process.platform } });
    expect(proxy).toBe(proxyOptions);
    expect(options.headers).not.toHaveProperty("Authorization");
  });

  it.each([
    [401, {}], [401, { code: "unauthenticated", message: "invalid api key" }],
    [200, { error: { code: "unauthenticated", message: "secret-token" } }],
    [500, { code: "unauthenticated", message: "secret-token" }],
  ])("rejects a refused key with safe status 401 (%s)", async (httpStatus, data) => {
    await expect(fetchDevinUserStatus("devin-key", { fetchFn: fixtureFetch(data, httpStatus) })).rejects.toMatchObject({ status: 401, message: "Devin authentication expired; sign in again" });
  });

  it("uses safe temporary errors for transport, malformed JSON and missing user status", async () => {
    for (const fetchFn of [
      vi.fn(async () => { throw new Error("secret-token"); }),
      vi.fn(async () => new Response("secret-token", { status: 200 })),
      fixtureFetch({}),
      fixtureFetch({ message: "secret-token" }, 503),
    ]) {
      await expect(fetchDevinUserStatus("devin-key", { fetchFn })).rejects.toThrow("temporarily unavailable");
    }
  });

  it("names organizations under the same email separately", () => {
    expect(getDevinIdentity(orgStatus("opt", "org_1", "devin-team$account-1").userStatus)).toEqual({ userName: "m@x.dev · opt", email: "m@x.dev", plan: "Devin Max", orgId: "org_1", teamId: "devin-team$account-1" });
    expect(getDevinIdentity(orgStatus("lab", "org_2", "devin-team$account-2").userStatus)).toEqual({ userName: "m@x.dev · lab", email: "m@x.dev", plan: "Devin Max", orgId: "org_2", teamId: "devin-team$account-2" });
  });
});

describe("Devin quota parsing against Magpie fixtures", () => {
  it("returns Teams day/week remaining shares and extra-usage balance", async () => {
    const result = await getDevinUsage({ accessToken: "devin-key" }, { fetchFn: fixtureFetch(status()) });
    expect(result).toMatchObject({ plan: "Devin Teams", periodEnd: "2026-10-26T21:45:55.000Z", balance: 46.807746,
      quotas: { daily: { used: 0, total: 100, remainingPercentage: 100, resetAt: "2026-10-01T08:00:00.000Z", unlimited: false },
        weekly: { used: 1, total: 100, remainingPercentage: 99, resetAt: "2026-10-04T08:00:00.000Z", unlimited: false } } });
    expect(result).not.toHaveProperty("message");
  });

  it("shows an omitted zero-valued week as exhausted when quota billing includes its reset", () => {
    const result = parseDevinUsage(status({ weeklyQuotaRemainingPercent: undefined }).userStatus);
    expect(result.quotas.weekly).toMatchObject({ used: 100, remainingPercentage: 0 });
    expect(result.quotas.daily).toMatchObject({ used: 0, remainingPercentage: 100 });
    const both = parseDevinUsage(status({ dailyQuotaRemainingPercent: undefined, weeklyQuotaRemainingPercent: undefined }).userStatus);
    expect(Object.values(both.quotas).map(q => q.used)).toEqual([100, 100]);
  });

  it("omits hidden windows and absent shares without resets while showing ACUs", () => {
    const s = status({ dailyQuotaResetAtUnix: undefined, dailyQuotaRemainingPercent: undefined, weeklyQuotaRemainingPercent: undefined, overageBalanceMicros: undefined, acuConsumed: 12.5, acuLimit: 50 });
    s.userStatus.planStatus.planInfo.hideWeeklyQuota = true;
    const result = parseDevinUsage(s.userStatus);
    expect(result.quotas).toEqual({ acus: { used: 12.5, total: 50, remainingPercentage: 75, resetAt: "2026-10-26T21:45:55.000Z", unlimited: false } });
  });

  it("does not invent exhausted windows for a credits-billed plan", () => {
    const s = status({ dailyQuotaRemainingPercent: undefined, weeklyQuotaRemainingPercent: undefined, overageBalanceMicros: undefined });
    s.userStatus.planStatus.planInfo.billingStrategy = "BILLING_STRATEGY_CREDITS";
    expect(parseDevinUsage(s.userStatus).quotas).toEqual({});
  });

  it("does not invent quotas for Free plans", () => {
    const result = parseDevinUsage({ planStatus: { planInfo: { planName: "Free" } } });
    expect(result.plan).toBe("Free");
    expect(result.quotas).toEqual({});
    expect(result.message).toContain("did not expose");
  });
});
