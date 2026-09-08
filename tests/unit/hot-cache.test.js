import { beforeEach, describe, expect, it, vi } from "vitest";

const client = {
  get: vi.fn(),
  set: vi.fn(async () => "OK"),
  del: vi.fn(async () => 1),
  incr: vi.fn(async () => 1),
  expire: vi.fn(async () => 1),
};

vi.mock("../../src/lib/redis/client.js", () => ({
  getRedisClient: vi.fn(async () => client),
}));

const hotCache = await import("../../src/lib/redis/hotCache.js");

describe("Redis hot cache", () => {
  beforeEach(() => vi.clearAllMocks());

  it("serializes JSON under the Spring Mouse namespace", async () => {
    client.get.mockResolvedValueOnce(JSON.stringify({ enabled: true }));
    await expect(hotCache.getHotJson("settings")).resolves.toEqual({ enabled: true });
    await expect(hotCache.setHotJson("settings", { enabled: false }, 45)).resolves.toBe(true);
    expect(client.get).toHaveBeenCalledWith("spring-mouse:hot:v1:settings");
    expect(client.set).toHaveBeenCalledWith("spring-mouse:hot:v1:settings", JSON.stringify({ enabled: false }), { EX: 45 });
  });

  it("fails open when Redis is unavailable", async () => {
    client.get.mockRejectedValueOnce(new Error("offline"));
    client.set.mockRejectedValueOnce(new Error("offline"));
    expect(await hotCache.getHotJson("settings")).toBeNull();
    expect(await hotCache.setHotJson("settings", {})).toBe(false);
  });
});
