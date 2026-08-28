import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticateOpenPlatformRequest: vi.fn(),
  getApiKeyById: vi.fn(),
  getApiKeys: vi.fn(),
  getUsageStats: vi.fn(),
  recordOpenPlatformRequest: vi.fn(),
}));

vi.mock("@/lib/openPlatform/auth", () => ({
  authenticateOpenPlatformRequest: mocks.authenticateOpenPlatformRequest,
}));

vi.mock("@/lib/localDb", () => ({
  getApiKeyById: mocks.getApiKeyById,
  getApiKeys: mocks.getApiKeys,
}));

vi.mock("@/lib/usageDb", () => ({
  getUsageStats: mocks.getUsageStats,
}));

vi.mock("@/lib/openPlatform/callLogging", () => ({
  recordOpenPlatformRequest: mocks.recordOpenPlatformRequest,
}));

const { GET: getReport } = await import("@/app/api/open/v1/usage/report/route.js");
const { GET: getUsers } = await import("@/app/api/open/v1/users/route.js");

const rangeQuery = "userId=key-a&startDate=2026-08-01T00%3A00%3A00%2B08%3A00&endDate=2026-08-28T23%3A59%3A59%2B08%3A00";

function request(path, query = "", headers = {}) {
  return new Request(`http://localhost${path}${query ? `?${query}` : ""}`, { headers });
}

function userUsage(overrides = {}) {
  return {
    requests: 10,
    completedRequests: 9,
    failedRequests: 1,
    cancelledRequests: 0,
    promptTokens: 1000,
    completionTokens: 500,
    cachedTokens: 200,
    cost: 1.25,
    requestDurationMs: 5000,
    durationRequestCount: 10,
    activeSessionDurationMs: 120000,
    activeDays: 2,
    sessionCount: 2,
    firstUsed: "2026-08-02T01:00:00.000Z",
    lastUsed: "2026-08-03T01:00:00.000Z",
    models: { "gpt-test": { requests: 10, promptTokens: 1000, completionTokens: 500, cachedTokens: 200, cost: 1.25 } },
    sourceIps: { "10.0.0.1": { requests: 10 } },
    apps: { Codex: { requests: 10, promptTokens: 1000, completionTokens: 500 } },
    periods: [0, 0, 4, 6, 0, 0],
    weekdays: [5, 5, 0, 0, 0, 0, 0],
    ...overrides,
  };
}

describe("open platform usage APIs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authenticateOpenPlatformRequest.mockResolvedValue({
      credential: { id: "open-key", name: "BI", keyPrefix: "smop_example" },
      error: null,
    });
    mocks.recordOpenPlatformRequest.mockImplementation(async ({ response }) => response);
    mocks.getApiKeyById.mockResolvedValue({ id: "key-a", name: "Alice", isActive: true, quotaMode: "unlimited" });
    mocks.getApiKeys.mockResolvedValue([
      { id: "key-a", name: "Alice", isActive: true, quotaMode: "unlimited", createdAt: "2026-07-01T00:00:00.000Z", lastUsedAt: null },
    ]);
    mocks.getUsageStats.mockResolvedValue({
      totalRequests: 30,
      totalPromptTokens: 3000,
      totalCompletionTokens: 1500,
      totalCost: 3.75,
      byUser: {
        "key-a": { ...userUsage(), userId: "key-a", keyName: "Alice" },
        "key-b": { ...userUsage({ requests: 20, completedRequests: 20, failedRequests: 0, promptTokens: 2000, completionTokens: 1000 }), userId: "key-b", keyName: "Bob" },
      },
    });
  });

  it("requires an open platform key", async () => {
    mocks.authenticateOpenPlatformRequest.mockResolvedValueOnce({ credential: null, error: "missing_api_key" });

    const response = await getReport(request("/api/open/v1/usage/report", rangeQuery));

    expect(response.status).toBe(401);
    expect((await response.json()).error.code).toBe("missing_api_key");
    expect(mocks.getApiKeyById).not.toHaveBeenCalled();
    expect(mocks.recordOpenPlatformRequest).not.toHaveBeenCalled();
  });

  it("requires a target userId", async () => {
    const response = await getReport(request("/api/open/v1/usage/report", "startDate=2026-08-01&endDate=2026-08-28"));

    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("invalid_user_id");
    expect(mocks.recordOpenPlatformRequest).toHaveBeenCalledWith(expect.objectContaining({
      credential: expect.objectContaining({ id: "open-key" }),
      response: expect.objectContaining({ status: 400 }),
      subjectUserId: null,
    }));
  });

  it("returns 404 for an unknown report user", async () => {
    mocks.getApiKeyById.mockResolvedValueOnce(null);

    const response = await getReport(request("/api/open/v1/usage/report", rangeQuery));

    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe("user_not_found");
    expect(mocks.recordOpenPlatformRequest).toHaveBeenCalledWith(expect.objectContaining({
      response: expect.objectContaining({ status: 404 }),
      subjectUserId: "key-a",
    }));
  });

  it("returns the requested user's report without other member identities", async () => {
    const response = await getReport(request("/api/open/v1/usage/report", rangeQuery));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(mocks.getApiKeyById).toHaveBeenCalledWith("key-a");
    expect(mocks.getUsageStats).toHaveBeenCalledWith("all", {
      startDate: "2026-07-31T16:00:00.000Z",
      endDate: "2026-08-28T15:59:59.000Z",
    });
    expect(body).toMatchObject({
      object: "usage_report",
      subject: { userId: "key-a", name: "Alice", hasUsage: true },
      usage: {
        requests: 10,
        successRate: 0.9,
        tokens: { prompt: 1000, completion: 500, cached: 200, total: 1500 },
      },
      comparison: { activeMemberCount: 2, ranks: { overall: 2, tokens: 2, requests: 2 } },
    });
    expect(JSON.stringify(body)).not.toContain("Bob");
    expect(JSON.stringify(body)).not.toContain("key-b");
    expect(mocks.recordOpenPlatformRequest).toHaveBeenCalledWith(expect.objectContaining({
      response: expect.objectContaining({ status: 200 }),
      subjectUserId: "key-a",
    }));
  });

  it("lists reportable users without returning model API key secrets", async () => {
    const response = await getUsers(request("/api/open/v1/users"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).toEqual([{
      userId: "key-a",
      name: "Alice",
      active: true,
      createdAt: "2026-07-01T00:00:00.000Z",
      lastUsedAt: null,
    }]);
    expect(JSON.stringify(body)).not.toContain("sk-");
    expect(mocks.recordOpenPlatformRequest).toHaveBeenCalledWith(expect.objectContaining({
      response: expect.objectContaining({ status: 200 }),
    }));
  });
});
