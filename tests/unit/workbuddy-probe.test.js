import { afterEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.hoisted(() => vi.fn());
vi.mock("open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: (...a) => fetchMock(...a) }));
vi.mock("@/lib/localDb", () => ({
  getProviderConnectionById: vi.fn(),
  updateProviderConnection: vi.fn(),
}));
vi.mock("@/lib/network/connectionProxy", () => ({ resolveConnectionProxyConfig: async () => ({ connectionProxyEnabled: false }) }));
vi.mock("@/lib/network/proxyTest", () => ({ testProxyUrl: vi.fn() }));

const { testSingleConnection } = await import("../../src/app/api/providers/[id]/test/testUtils.js");
const db = await import("@/lib/localDb");

const ok = () => ({ ok: true, status: 200, json: async () => ({ code: 0, data: { Response: { Data: { Accounts: [] } } } }) });
const migratedCn = (over = {}) => ({
  id: "c1", provider: "workbuddy", authType: "oauth", accessToken: "fixture-access",
  providerSpecificData: {
    codebuddyUid: "u1", workbuddyLegacyCredential: true,
    workbuddyEndpointOrigin: "https://copilot.tencent.com", ...over,
  },
});
const migratedIntl = {
  id: "c2", provider: "workbuddy-ai", authType: "oauth", accessToken: "fixture-access",
  providerSpecificData: { workbuddyLegacyCredential: true, workbuddyEndpointOrigin: "https://www.codebuddy.ai" },
};
const freshAi = {
  id: "c3", provider: "workbuddy-ai", authType: "oauth", accessToken: "fixture-access",
  providerSpecificData: { workbuddyProduct: "workbuddy-ai", codebuddyUid: "u3" },
};

afterEach(() => { fetchMock.mockReset(); vi.clearAllMocks(); });

describe("per-account test for the replaced CodeBuddy channels", () => {
  it.each([
    [migratedCn(), "https://copilot.tencent.com"],
    [migratedIntl, "https://www.codebuddy.ai"],
    [freshAi, "https://www.workbuddy.ai"],
  ])("probes $1.provider at the origin its credential belongs to", async (connection, origin) => {
    db.getProviderConnectionById.mockResolvedValue(connection);
    fetchMock.mockResolvedValue(ok());
    const result = await testSingleConnection(connection.id);
    expect(result.valid).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(`${origin}/v2/billing/meter/get-user-resource`);
    expect(db.updateProviderConnection).toHaveBeenCalledWith(connection.id, expect.objectContaining({ testStatus: "active" }));
  });

  it("reports a rejected credential as failed instead of claiming success", async () => {
    db.getProviderConnectionById.mockResolvedValue(migratedCn());
    fetchMock.mockResolvedValue({ ok: false, status: 403, json: async () => ({}) });
    const result = await testSingleConnection("c1");
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/rejected/i);
    expect(db.updateProviderConnection).toHaveBeenCalledWith("c1", expect.objectContaining({ testStatus: "error" }));
  });

  it("reports an endpoint-level business error as failed", async () => {
    db.getProviderConnectionById.mockResolvedValue(migratedIntl);
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ code: 11128, msg: "request illegal" }) });
    const result = await testSingleConnection("c2");
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/11128/);
  });

  it("is not silently 'supported' without a token", async () => {
    db.getProviderConnectionById.mockResolvedValue({ ...migratedCn(), accessToken: "" });
    const result = await testSingleConnection("c1");
    expect(result.valid).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
