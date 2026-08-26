import { beforeEach, describe, expect, it, vi } from "vitest";

const client = {
  eval: vi.fn(async () => "1-0"),
  get: vi.fn(async () => null),
  sendCommand: vi.fn(async () => "OK"),
  lRange: vi.fn(async () => []),
  set: vi.fn(async () => "OK"),
  xLen: vi.fn(async () => 0),
  xPending: vi.fn(async () => ({ pending: 0 })),
  duplicate: vi.fn(() => ({
    isOpen: true,
    on: vi.fn(),
    connect: vi.fn(async () => {}),
    subscribe: vi.fn(async (_channel, callback) => callback()),
    unsubscribe: vi.fn(async () => {}),
    quit: vi.fn(async () => {}),
  })),
};

vi.mock("../../src/lib/redis/client.js", () => ({
  getRedisClient: vi.fn(async () => client),
  isRedisConfigured: vi.fn(() => true),
}));

const live = await import("../../src/lib/redis/liveUsage.js");

describe("Redis live usage layer", () => {
  beforeEach(() => vi.clearAllMocks());

  it("queues one compact usage event and increments initialized quota counters atomically", async () => {
    const event = { requestId: "r1", promptTokens: 10, completionTokens: 5 };
    const counters = [{ key: "quota:5h", delta: 15 }, { key: "quota:week", delta: 15 }];

    await expect(live.enqueueUsageEvent(event, counters)).resolves.toBe(true);
    expect(client.eval).toHaveBeenCalledOnce();
    const [, options] = client.eval.mock.calls[0];
    expect(options.keys).toEqual([
      live.USAGE_STREAM_KEY,
      "spring-mouse:usage:recent",
      expect.stringMatching(/^spring-mouse:usage:seen:/),
      "quota:5h",
      "quota:week",
    ]);
    expect(options.arguments).toEqual([JSON.stringify(event), "200", String(8 * 24 * 60 * 60), "2", "15", "15"]);
    expect(options.keys[2]).not.toContain(event.requestId);
  });

  it("initializes a missing quota counter with an absolute expiry", async () => {
    client.get.mockResolvedValueOnce("42");
    const resetAt = new Date(Date.now() + 60000).toISOString();
    await expect(live.initializeQuotaCounter("key-1", "fiveHour", resetAt, 42)).resolves.toBe(42);
    expect(client.sendCommand.mock.calls[0][0].slice(0, 4)).toEqual([
      "SET",
      live.quotaCounterKey("key-1", "fiveHour", resetAt),
      "42",
      "NX",
    ]);
  });

  it("reports writer heartbeat health", async () => {
    client.get.mockResolvedValueOnce(String(Date.now()));
    const health = await live.getUsageQueueHealth();
    expect(health).toMatchObject({ configured: true, pending: 0, length: 0, writerHealthy: true });
  });

  it("mirrors active request counts without storing caller credentials", async () => {
    await expect(live.updateActiveFlow("flow-1", {
      model: "gpt-test",
      provider: "codex",
      connectionId: "connection-1",
    }, 1)).resolves.toBe(true);
    const [, options] = client.eval.mock.calls[0];
    expect(options.keys).toEqual(["spring-mouse:active:flow:flow-1"]);
    expect(options.arguments).toEqual(["1", "gpt-test", "codex", "connection-1", expect.any(String)]);
    expect(JSON.stringify(options)).not.toContain("sk-");
  });

  it("subscribes to writer commit notifications", async () => {
    const onCommit = vi.fn();
    await expect(live.startUsageCommitSubscriber(onCommit)).resolves.toBe(true);
    expect(onCommit).toHaveBeenCalledOnce();
    await live.stopUsageCommitSubscriber();
  });
});
