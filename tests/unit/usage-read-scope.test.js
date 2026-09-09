import { beforeEach, describe, expect, it, vi } from "vitest";

const getUsageStats = vi.fn(async () => ({ totalRequests: 1 }));
const getChartData = vi.fn(async () => []);
const getUsageDetails = vi.fn(async () => ({ details: [], pagination: { totalItems: 0 } }));
const resolveUsageDashboardScope = vi.fn(async () => ({ apiKeyIds: ["tagged-key"] }));

vi.mock("@/lib/usageDb", () => ({
  getUsageStats,
  getChartData,
  getUsageDetails,
}));

vi.mock("@/lib/usageDashboardScope", () => ({
  resolveUsageDashboardScope,
}));

const { GET: getStats } = await import("../../src/app/api/usage/stats/route.js");
const { GET: getChart } = await import("../../src/app/api/usage/chart/route.js");
const { GET: getDetails } = await import("../../src/app/api/usage/details/route.js");

describe("usage read scope boundaries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("keeps the home-page stats request unrestricted", async () => {
    await getStats(new Request("http://localhost/api/usage/stats?period=today"));

    expect(resolveUsageDashboardScope).not.toHaveBeenCalled();
    expect(getUsageStats).toHaveBeenCalledWith("today", {
      startDate: null,
      endDate: null,
      apiKeyId: null,
      apiKeyIds: null,
    });
  });

  it("applies the tag scope only when the usage page opts in", async () => {
    await getStats(new Request("http://localhost/api/usage/stats?period=7d&scope=dashboard&apiKeyId=tagged-key"));

    expect(resolveUsageDashboardScope).toHaveBeenCalledWith("tagged-key");
    expect(getUsageStats).toHaveBeenCalledWith("7d", {
      startDate: null,
      endDate: null,
      apiKeyId: "tagged-key",
      apiKeyIds: ["tagged-key"],
    });
  });

  it("uses the same opt-in boundary for chart data", async () => {
    await getChart(new Request("http://localhost/api/usage/chart?period=today"));

    expect(resolveUsageDashboardScope).not.toHaveBeenCalled();
    expect(getChartData).toHaveBeenCalledWith("today", {
      startDate: null,
      endDate: null,
      apiKeyId: null,
      apiKeyIds: null,
    });
  });

  it("never applies the dashboard tag scope to call records", async () => {
    await getDetails(new Request("http://localhost/api/usage/details?page=2&pageSize=20&provider=openai"));

    expect(resolveUsageDashboardScope).not.toHaveBeenCalled();
    expect(getUsageDetails).toHaveBeenCalledWith({
      page: 2,
      pageSize: 20,
      startDate: null,
      endDate: null,
      provider: "openai",
    });
  });
});
