import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getOpenPlatformApiKeys: vi.fn(),
  createOpenPlatformApiKey: vi.fn(),
  updateOpenPlatformApiKey: vi.fn(),
  deleteOpenPlatformApiKey: vi.fn(),
}));

vi.mock("@/lib/localDb", () => mocks);

const { GET, POST } = await import("@/app/api/open-platform/keys/route.js");
const { PUT, DELETE } = await import("@/app/api/open-platform/keys/[id]/route.js");

function jsonRequest(url, method, body) {
  return new Request(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

describe("open platform key management API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getOpenPlatformApiKeys.mockResolvedValue([]);
    mocks.createOpenPlatformApiKey.mockResolvedValue({ id: "open-1", name: "BI", key: "smop_secret" });
    mocks.updateOpenPlatformApiKey.mockResolvedValue({ id: "open-1", name: "BI", isActive: false });
    mocks.deleteOpenPlatformApiKey.mockResolvedValue(true);
  });

  it("lists credentials without caching", async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
  });

  it("creates and returns the one-time secret", async () => {
    const response = await POST(jsonRequest("http://localhost/api/open-platform/keys", "POST", { name: "BI" }));
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({ key: { key: "smop_secret" } });
  });

  it("rejects an empty name", async () => {
    const response = await POST(jsonRequest("http://localhost/api/open-platform/keys", "POST", { name: " " }));
    expect(response.status).toBe(400);
  });

  it("updates active state", async () => {
    const response = await PUT(jsonRequest("http://localhost/api/open-platform/keys/open-1", "PUT", { isActive: false }), { params: Promise.resolve({ id: "open-1" }) });
    expect(response.status).toBe(200);
    expect(mocks.updateOpenPlatformApiKey).toHaveBeenCalledWith("open-1", { isActive: false });
  });

  it("deletes a credential", async () => {
    const response = await DELETE(new Request("http://localhost/api/open-platform/keys/open-1", { method: "DELETE" }), { params: Promise.resolve({ id: "open-1" }) });
    expect(response.status).toBe(200);
  });
});
