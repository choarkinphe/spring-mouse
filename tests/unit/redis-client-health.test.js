import { afterAll, describe, expect, it, vi } from "vitest";

const { client, createClient } = vi.hoisted(() => {
  const mockedClient = {
    isReady: false,
    isOpen: true,
    on: vi.fn(),
    connect: vi.fn(async () => { mockedClient.isReady = true; }),
    ping: vi.fn(async () => "PONG"),
    info: vi.fn(async (section) => section === "memory"
      ? "# Memory\r\nused_memory:12582912\r\nused_memory_rss:18874368\r\nmaxmemory:0\r\nmem_fragmentation_ratio:1.5\r\n"
      : "# Persistence\r\naof_enabled:1\r\naof_current_size:2097152\r\n"),
    dbSize: vi.fn(async () => 42),
    quit: vi.fn(async () => { mockedClient.isOpen = false; }),
    destroy: vi.fn(),
  };
  return { client: mockedClient, createClient: vi.fn(() => mockedClient) };
});

vi.mock("redis", () => ({ createClient }));

process.env.SPRING_MOUSE_REDIS_URL = "redis://127.0.0.1:6379";
delete global.__springMouseRedis;

const { closeRedisClient, getRedisHealth, parseRedisInfo } = await import("../../src/lib/redis/client.js");

afterAll(async () => {
  await closeRedisClient();
  delete process.env.SPRING_MOUSE_REDIS_URL;
  delete global.__springMouseRedis;
});

describe("Redis client health metrics", () => {
  it("parses Redis INFO sections without losing values containing separators", () => {
    expect(parseRedisInfo("used_memory:10\r\nconfig_file:/app/data/redis/redis.conf\r\n")).toEqual({
      used_memory: "10",
      config_file: "/app/data/redis/redis.conf",
    });
  });

  it("reports connection, memory, persistence and key usage", async () => {
    const health = await getRedisHealth();

    expect(health).toMatchObject({
      configured: true,
      connected: true,
      keyCount: 42,
      memory: {
        usedBytes: 12 * 1024 * 1024,
        rssBytes: 18 * 1024 * 1024,
        maxBytes: 0,
        fragmentationRatio: 1.5,
      },
      persistence: {
        aofEnabled: true,
        aofSizeBytes: 2 * 1024 * 1024,
      },
      metricsError: null,
      error: null,
    });
    expect(health.latencyMs).toEqual(expect.any(Number));
    expect(client.info).toHaveBeenCalledWith("memory");
    expect(client.info).toHaveBeenCalledWith("persistence");
    expect(client.dbSize).toHaveBeenCalledOnce();
  });
});
