import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ createClient: vi.fn() }));
vi.mock("redis", () => ({ createClient: mocks.createClient }));
let api, client;
beforeEach(async () => {
  vi.useFakeTimers(); vi.resetModules();
  delete globalThis.__smRoutingRedis;
  vi.stubEnv("SPRING_MOUSE_REDIS_URL", "redis://localhost:6379");
  vi.stubEnv("SPRING_MOUSE_ROUTING_REDIS_TIMEOUT_MS", "200");
  client = { isReady: false, on: vi.fn(), destroy: vi.fn(), connect: vi.fn(async () => { client.isReady = true; }) };
  mocks.createClient.mockReset().mockReturnValue(client);
  api = await import("../../src/lib/redis/routingClient.js");
});
afterEach(() => { api.closeRoutingRedis(); vi.unstubAllEnvs(); vi.useRealTimers(); });
describe("bounded best-effort Redis", () => {
  it("coalesces concurrent connections and disables offline replay", async () => {
    const operation = vi.fn(async () => "ok");
    expect(await Promise.all(Array.from({ length: 100 }, () => api.routingRedis(operation)))).toEqual(Array(100).fill("ok"));
    expect(client.connect).toHaveBeenCalledOnce();
    expect(mocks.createClient.mock.calls[0][0]).toMatchObject({ disableOfflineQueue: true, commandsQueueMaxLength: 2048, socket: { reconnectStrategy: false } });
    expect(vi.getTimerCount()).toBe(0);
  });
  it("bounds a stalled command, destroys its socket and backs off without replay", async () => {
    const operation = vi.fn(() => new Promise(() => {}));
    const pending = api.routingRedis(operation);
    await vi.advanceTimersByTimeAsync(201);
    expect(await pending).toBeNull(); expect(client.destroy).toHaveBeenCalledOnce();
    expect(await api.routingRedis(operation)).toBeNull(); expect(operation).toHaveBeenCalledOnce();
    expect(api.getRoutingRedisStatus().timeouts).toBe(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await api.routingRedis(async () => "recovered")).toBe("recovered");
    expect(client.connect).toHaveBeenCalledTimes(2);
  });
  it("does not issue a mutation after a late connection resolves", async () => {
    let connected;
    client.connect.mockImplementation(() => new Promise((resolve) => { connected = resolve; }));
    const operation = vi.fn();
    const pending = api.routingRedis(operation);
    await vi.advanceTimersByTimeAsync(201); expect(await pending).toBeNull();
    connected(); await Promise.resolve(); await Promise.resolve();
    expect(operation).not.toHaveBeenCalled();
  });
  it("fails open on errors and when Redis is not configured", async () => {
    expect(await api.routingRedis(async () => { throw new Error("offline"); })).toBeNull();
    expect(api.getRoutingRedisStatus().errors).toBe(1);
    api.closeRoutingRedis(); vi.stubEnv("SPRING_MOUSE_REDIS_URL", "");
    const operation = vi.fn(); expect(await api.routingRedis(operation)).toBeNull();
    expect(operation).not.toHaveBeenCalled();
  });
  it("a late failure cannot destroy a replacement connection", async () => {
    let rejectOld;
    const old = api.routingRedis(() => new Promise((_, reject) => { rejectOld = reject; }));
    await vi.advanceTimersByTimeAsync(201); await old;
    await vi.advanceTimersByTimeAsync(1000);
    const replacement = { ...client, isReady: true, destroy: vi.fn(), connect: vi.fn(async () => {}) };
    mocks.createClient.mockReturnValue(replacement);
    expect(await api.routingRedis(async () => 1)).toBe(1);
    rejectOld(new Error("late failure")); await Promise.resolve(); await Promise.resolve();
    expect(replacement.destroy).not.toHaveBeenCalled();
  });
});
