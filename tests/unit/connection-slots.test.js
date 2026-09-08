import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ eval: vi.fn(), zRem: vi.fn(async () => 1), offline: false }));
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
    expect(lease.connectionId).toBe("b"); expect(mocks.eval).toHaveBeenCalledOnce();
    expect(mocks.eval.mock.calls[0][1].keys).toHaveLength(2);
    await lease.release(); await lease.release();
    expect(mocks.zRem).toHaveBeenCalledOnce();
    expect(slots.getLocalSlotStatus().active).toBe(0);
  });
  it("uses different release tokens for overlapping requests", async () => {
    leases = await Promise.all(Array.from({length: 100}, () => slots.reserveConnectionSlot(candidates)));
    const tokens = mocks.eval.mock.calls.map(([, opts]) => opts.arguments[0]);
    expect(new Set(tokens).size).toBe(100);
    expect(slots.getLocalSlotStatus().active).toBe(100);
  });
  it("balances AND counts overflow during Redis outage", async () => {
    mocks.offline = true;
    leases = await Promise.all(Array.from({length: 20}, () => slots.reserveConnectionSlot(candidates)));
    expect(leases.filter((l) => l.connectionId === "a")).toHaveLength(10);
    expect(leases.filter((l) => l.connectionId === "b")).toHaveLength(10);
    expect(slots.getLocalSlotStatus()).toEqual({active: 20, redis: 0});
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
