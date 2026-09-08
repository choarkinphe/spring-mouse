import { beforeEach, describe, expect, it, vi } from "vitest";

const client = {
  eval: vi.fn(async () => 1),
  mGet: vi.fn(async () => ["2", null]),
};

vi.mock("../../src/lib/redis/client.js", () => ({
  getRedisClient: vi.fn(async () => client),
}));

const slots = await import("../../src/lib/redis/connectionSlots.js");

describe("connection slot reservations", () => {
  beforeEach(() => vi.clearAllMocks());

  it("uses a safe default and allows a per-connection override", () => {
    expect(slots.getConnectionConcurrencyLimit({ providerSpecificData: { maxConcurrentStreams: 2 } })).toBe(2);
    expect(slots.getConnectionConcurrencyLimit({}, { maxConcurrentStreams: 3 })).toBe(3);
    expect(slots.getConnectionConcurrencyLimit({})).toBeGreaterThan(0);
  });

  it("atomically reserves and releases a connection slot", async () => {
    await expect(slots.reserveConnectionSlot("conn-1", 4)).resolves.toBe(true);
    await expect(slots.releaseConnectionSlot("conn-1")).resolves.toBe(true);
    expect(client.eval).toHaveBeenCalledTimes(2);
    expect(client.eval.mock.calls[0][1].keys).toEqual(["spring-mouse:routing:connection:conn-1:active"]);
    expect(client.eval.mock.calls[0][1].arguments[0]).toBe("4");
  });

  it("returns false when Redis reports a full account and fails open on Redis outage", async () => {
    client.eval.mockResolvedValueOnce(0);
    await expect(slots.reserveConnectionSlot("conn-1", 1)).resolves.toBe(false);
    client.eval.mockRejectedValueOnce(new Error("redis unavailable"));
    await expect(slots.reserveConnectionSlot("conn-1", 1)).resolves.toBeNull();
  });

  it("reads account load in one Redis round trip", async () => {
    await expect(slots.getConnectionSlotUsage(["a", "b"])).resolves.toEqual({ a: 2, b: 0 });
    expect(client.mGet).toHaveBeenCalledWith([
      "spring-mouse:routing:connection:a:active",
      "spring-mouse:routing:connection:b:active",
    ]);
  });
});
