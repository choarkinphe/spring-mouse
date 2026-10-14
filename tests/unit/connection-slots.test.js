import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  eval: vi.fn(), zRem: vi.fn(async () => 1), zRemRangeByScore: vi.fn(async () => 0),
  zCard: vi.fn(async () => 0), zAdd: vi.fn(async () => 1), pExpire: vi.fn(async () => 1),
  offline: false,
}));
vi.mock("../../src/lib/redis/routingClient.js", () => ({ routingRedis: async (fn) => mocks.offline ? null : fn(mocks) }));
const slots = await import("../../src/lib/redis/connectionSlots.js");
const candidates = [{ id: "a", limit: 2 }, { id: "b", limit: 2 }];
let leases = [];
afterEach(async () => { for (const lease of leases) await lease.release(); leases = []; });
beforeEach(() => { vi.clearAllMocks(); mocks.offline = false; mocks.eval.mockResolvedValue(1); });
describe("unique account leases", () => {
  it("chooses and reserves in one command even with many accounts", async () => {
    mocks.eval.mockResolvedValue(2);
    const lease = await slots.reserveConnectionSlot(candidates); leases.push(lease);
    expect(lease.connectionId).toBe("b"); expect(mocks.eval).toHaveBeenCalledTimes(2);
    expect(mocks.eval.mock.calls[1][1].keys).toHaveLength(4);
    await lease.release(); await lease.release();
    expect(mocks.zRem).toHaveBeenCalled();
    expect(slots.getLocalSlotStatus().active).toBe(0);
  });
  it("uses different release tokens for overlapping requests", async () => {
    leases = await Promise.all(Array.from({length: 100}, () => slots.reserveConnectionSlot(candidates, { maxQueueSize: 200 })));
    const tokens = mocks.eval.mock.calls.filter(([script]) => script === slots.HARD_RESERVE_SCRIPT).map(([, opts]) => opts.arguments[0]);
    expect(new Set(tokens).size).toBe(100);
    expect(slots.getLocalSlotStatus().active).toBe(100);
  });
  it("keeps account caps during Redis outage", async () => {
    mocks.offline = true;
    const results = await Promise.allSettled(Array.from({ length: 6 }, () => slots.reserveConnectionSlot(candidates, {
      queueTimeoutMs: 20,
    })));
    const admitted = results.filter((result) => result.status === "fulfilled").map((result) => result.value);
    leases.push(...admitted);
    expect(admitted.filter((lease) => lease.connectionId === "a")).toHaveLength(2);
    expect(admitted.filter((lease) => lease.connectionId === "b")).toHaveLength(2);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(2);
    expect(slots.getLocalSlotStatus()).toEqual({ active: 4, redis: 0, queued: 0 });
  });
  it("shares live accounting across module reloads / route bundles", async () => {
    const lease = await slots.reserveConnectionSlot(candidates); leases.push(lease);
    vi.resetModules();
    const reloaded = await import("../../src/lib/redis/connectionSlots.js");
    expect(reloaded.getLocalSlotStatus().active).toBe(1);
    await lease.release();
    expect(reloaded.getLocalSlotStatus().active).toBe(0);
  });
  it("uses account/provider overrides and a consistent default", () => {
    expect(slots.getConnectionConcurrencyLimit({providerSpecificData: {maxConcurrentStreams: 2}})).toBe(2);
    expect(slots.getConnectionConcurrencyLimit({}, {maxConcurrentStreams: 3})).toBe(3);
    expect(slots.getConnectionConcurrencyLimit({})).toBe(16);
  });
});

describe("hard provider and account gates", () => {
  it("queues once either cap is exhausted and admits after release", async () => {
    mocks.offline = true;
    const first = await slots.reserveConnectionSlot(candidates, {
      providerId: "hard-test", providerLimit: 2, weight: 1, queueTimeoutMs: 500,
    });
    const second = await slots.reserveConnectionSlot(candidates, {
      providerId: "hard-test", providerLimit: 2, weight: 1, queueTimeoutMs: 500,
    });
    expect(first.connectionId).toBe("a");
    // Candidate order preserves sticky affinity while capacity remains.
    expect(second.connectionId).toBe("a");
    const queuedPromise = slots.reserveConnectionSlot(candidates, {
      providerId: "hard-test", providerLimit: 2, weight: 1, queueTimeoutMs: 50,
    });
    await expect(queuedPromise).rejects.toMatchObject({ code: "ROUTING_QUEUE_TIMEOUT" });
    expect(slots.getLocalSlotStatus().active).toBe(2);

    await first.release();
    const third = await slots.reserveConnectionSlot(candidates, {
      providerId: "hard-test", providerLimit: 2, weight: 1, queueTimeoutMs: 100,
    });
    leases.push(second, third);
    expect(third.connectionId).toBe("a");
    expect(slots.getLocalSlotStatus().active).toBe(2);
    await Promise.all([second, third].map((lease) => lease.release()));
  });

  it("charges weighted large requests against both gates", async () => {
    mocks.offline = true;
    const candidates = [{ id: "weighted-a", limit: 3 }];
    const first = await slots.reserveConnectionSlot(candidates, {
      providerId: "weight-test", providerLimit: 3, weight: 2, queueTimeoutMs: 100,
    });
    leases.push(first);
    const second = slots.reserveConnectionSlot(candidates, {
      providerId: "weight-test", providerLimit: 3, weight: 2, queueTimeoutMs: 20,
    });
    await expect(second).rejects.toMatchObject({ code: "ROUTING_QUEUE_TIMEOUT" });
    expect(slots.getConnectionConcurrencyLimit({}, {})).toBe(16);
  });

  it("estimates long-context requests with a bounded weight", () => {
    expect(slots.estimateRequestWeight({ messages: Array(10) })).toBe(1);
    expect(slots.estimateRequestWeight({ messages: Array.from({length: 120}, () => ({role: "user", content: "short"})) })).toBe(1);
    expect(slots.estimateRequestWeight({ input: [{content: "x".repeat(900_000)}] })).toBe(8);
    expect(slots.estimateRequestWeight({ tools: Array.from({length: 140}, () => ({type: "function", function: {name: "tool", parameters: {type: "object"}}})) })).toBe(1);
    expect(slots.estimateRequestWeight({ tools: [{description: "x".repeat(220_000)}] })).toBe(3);
    expect(slots.estimateRequestWeight({ input: "x".repeat(120_000) })).toBe(2);
  });
});

describe("admission lifecycle", () => {
  it("does not acquire anything for an already cancelled request", async () => {
    const controller = new AbortController(); controller.abort();
    await expect(slots.reserveConnectionSlot(candidates, {signal: controller.signal})).rejects.toMatchObject({name: "AbortError"});
    expect(mocks.eval).not.toHaveBeenCalled();
    expect(slots.getLocalSlotStatus().active).toBe(0);
  });
  it("releases if cancellation races the Redis admission reply", async () => {
    const controller = new AbortController();
    mocks.eval.mockImplementation(async (script) => {
      if (script === slots.HARD_RESERVE_SCRIPT) controller.abort();
      return 1;
    });
    await expect(slots.reserveConnectionSlot(candidates, {signal: controller.signal})).rejects.toMatchObject({name: "AbortError"});
    expect(slots.getLocalSlotStatus()).toEqual({active: 0, redis: 0, queued: 0});
    expect(mocks.zRem.mock.calls.some(([key]) => key.includes("slots:v3:a"))).toBe(true);
  });
  it("releases immediately on cancellation after returning credentials", async () => {
    const controller = new AbortController();
    const lease = await slots.reserveConnectionSlot(candidates, {signal: controller.signal}); leases.push(lease);
    controller.abort();
    expect(slots.getLocalSlotStatus().active).toBe(0);
    await lease.release();
  });
  it("uses the remaining request budget instead of restarting a queue window", async () => {
    mocks.offline = true;
    const held = await slots.reserveConnectionSlot([{id:"deadline",limit:1}]); leases.push(held);
    const start = Date.now();
    await expect(slots.reserveConnectionSlot([{id:"deadline",limit:1}], {
      deadlineMs: start + 40, queueTimeoutMs: 60_000,
    })).rejects.toMatchObject({reason:"deadline_exceeded"});
    expect(Date.now() - start).toBeLessThan(500);
    expect(slots.getLocalSlotStatus().queued).toBe(0);
  });
  it("refreshes stale accounts without dispatching to a now disabled account", async () => {
    mocks.offline = true;
    const refreshCandidates = vi.fn(async () => [{id:"fresh",limit:2}]);
    const validateCandidate = vi.fn(async id => id === "fresh");
    const lease = await slots.reserveConnectionSlot(candidates, {refreshCandidates,validateCandidate}); leases.push(lease);
    expect(lease.connectionId).toBe("fresh");
    expect(slots.getConnectionSlotCounts()).toEqual({fresh:1});
    expect(refreshCandidates).toHaveBeenCalledOnce();
  });
  it("does not retain a lease if post-admission validation throws", async () => {
    await expect(slots.reserveConnectionSlot(candidates, {validateCandidate: async () => {throw new Error("DB unavailable");}})).rejects.toThrow("DB unavailable");
    expect(slots.getLocalSlotStatus()).toEqual({active:0,redis:0,queued:0});
  });
  it("rejects weights that cannot fit without occupying the queue", async () => {
    await expect(slots.reserveConnectionSlot(candidates, {weight:8})).rejects.toMatchObject({reason:"weight_exceeds_capacity"});
    expect(slots.getLocalSlotStatus().queued).toBe(0);
  });
});


it("fits estimated weights to odd, small and provider-wide capacities", () => {
  expect(slots.getRequestWeightLimit([{limit:15}],50)).toBe(7);
  expect(slots.getRequestWeightLimit([{limit:30}],80)).toBe(8);
  expect(slots.getRequestWeightLimit([{limit:1}],50)).toBe(1);
  expect(slots.getRequestWeightLimit([{limit:30}],3)).toBe(1);
  expect(slots.getRequestWeightLimit([{limit:1},{limit:15}],50)).toBe(7);
});
