import { afterEach, describe, expect, it, vi } from "vitest";

const getRedisHealth = vi.fn();
const getUsageQueueHealth = vi.fn();

vi.mock("../../src/lib/redis/client.js", () => ({ getRedisHealth }));
vi.mock("../../src/lib/redis/liveUsage.js", () => ({ getUsageQueueHealth }));

const { GET } = await import("../../src/app/api/health/route.js");

afterEach(() => {
  delete process.env.SPRING_MOUSE_REDIS_REQUIRED;
  vi.clearAllMocks();
});

describe("health route embedded Redis status", () => {
  it("keeps non-Docker development healthy when Redis is not configured", async () => {
    getRedisHealth.mockResolvedValue({ configured: false, connected: false });
    getUsageQueueHealth.mockResolvedValue({ configured: false, pending: 0, length: 0 });
    const response = await GET();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, redisRequired: false });
  });

  it("fails Docker health when the required writer is stale", async () => {
    process.env.SPRING_MOUSE_REDIS_REQUIRED = "true";
    getRedisHealth.mockResolvedValue({ configured: true, connected: true });
    getUsageQueueHealth.mockResolvedValue({ configured: true, writerHealthy: false, pending: 1, length: 1 });
    const response = await GET();
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ ok: false, redisRequired: true });
  });
});
