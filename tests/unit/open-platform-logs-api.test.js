import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getOpenPlatformApiCallLogs: vi.fn(),
}));

vi.mock("@/lib/localDb", () => mocks);

const { GET } = await import("@/app/api/open-platform/logs/route.js");

describe("open platform call logs API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getOpenPlatformApiCallLogs.mockResolvedValue({
      logs: [],
      pagination: { page: 1, pageSize: 30, totalItems: 0, totalPages: 0 },
    });
  });

  it("lists records without caching and passes filters", async () => {
    const response = await GET(new Request("http://localhost/api/open-platform/logs?page=2&pageSize=20&apiKeyId=key-a"));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(mocks.getOpenPlatformApiCallLogs).toHaveBeenCalledWith({ apiKeyId: "key-a", page: 2, pageSize: 20 });
  });

  it.each([
    "page=0",
    "page=1.5",
    "pageSize=0",
    "pageSize=101",
  ])("rejects invalid pagination: %s", async (query) => {
    const response = await GET(new Request(`http://localhost/api/open-platform/logs?${query}`));

    expect(response.status).toBe(400);
    expect(mocks.getOpenPlatformApiCallLogs).not.toHaveBeenCalled();
  });

  it("rejects an oversized API key filter", async () => {
    const response = await GET(new Request(`http://localhost/api/open-platform/logs?apiKeyId=${"a".repeat(129)}`));

    expect(response.status).toBe(400);
    expect(mocks.getOpenPlatformApiCallLogs).not.toHaveBeenCalled();
  });
});
