import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.hoisted(() => vi.fn());
// The module under test imports through the `open-sse/` alias, so the mock has to
// be registered under that specifier too or the real network path is used.
vi.mock("open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: (...a) => fetchMock(...a) }));
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: (...a) => fetchMock(...a) }));

const { getUsageForProvider } = await import("../../open-sse/services/usage.js");

const billing = () => ({ ok: true, status: 200, json: async () => ({
  code: 0,
  data: { Response: { Data: { Accounts: [
    // DeductionEndTime is epoch milliseconds upstream; the refill/bonus split
    // compares it against the parsed CycleEndTime, so a string would be misread.
    { PackageName: "Pro", CycleCapacitySize: 500, CycleCapacityUsed: 100,
      CycleStartTime: "2026-10-01T00:00:00Z", CycleEndTime: "2026-11-01T00:00:00Z",
      DeductionEndTime: Date.parse("2026-12-01T00:00:00Z") },
  ] } } },
}) });

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("real network forbidden in this test"); }));
  fetchMock.mockResolvedValue(billing());
});
afterEach(() => { vi.unstubAllGlobals(); fetchMock.mockReset(); });

describe("quota dispatch for the replaced CodeBuddy channels", () => {
  it.each([
    ["workbuddy", { workbuddyLegacyCredential: true, workbuddyEndpointOrigin: "https://copilot.tencent.com" }, "https://copilot.tencent.com"],
    ["workbuddy-ai", { workbuddyLegacyCredential: true, workbuddyEndpointOrigin: "https://www.codebuddy.ai" }, "https://www.codebuddy.ai"],
    ["workbuddy-ai", { workbuddyProduct: "workbuddy-ai" }, "https://www.workbuddy.ai"],
  ])("returns quotas for %s at its own origin", async (provider, meta, origin) => {
    const usage = await getUsageForProvider({ provider, accessToken: "fixture-token", providerSpecificData: meta });
    expect(usage.message).toBeUndefined();
    expect(usage.quotas).toBeTruthy();
    expect(Object.values(usage.quotas)[0]).toMatchObject({ total: 500, used: 100 });
    expect(fetchMock.mock.calls[0][0]).toBe(`${origin}/v2/billing/meter/get-user-resource`);
  });

  it("dispatches without a missing-export error", async () => {
    const usage = await getUsageForProvider({ provider: "workbuddy", accessToken: "t", providerSpecificData: {} });
    expect(JSON.stringify(usage)).not.toMatch(/is not defined/);
  });

  it("keeps the legacy CodeBuddy ids working", async () => {
    const usage = await getUsageForProvider({ provider: "codebuddy-intl", accessToken: "t", providerSpecificData: {} });
    expect(usage.quotas).toBeTruthy();
  });
});
