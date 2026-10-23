import { beforeEach, describe, expect, it, vi } from "vitest";

const { rows, adapter } = vi.hoisted(() => {
  const rows = new Map();
  return { rows, adapter: {
    get: vi.fn((sql, [scope, key]) => rows.has(`${scope}:${key}`) ? { value: rows.get(`${scope}:${key}`) } : undefined),
    run: vi.fn((sql, [scope, key, value]) => rows.set(`${scope}:${key}`, value)),
    transaction: (fn) => fn(),
    flush: vi.fn(),
  } };
});
vi.mock("../../src/lib/db/driver.js", () => ({ getAdapter: async () => adapter }));
vi.mock("../../src/lib/db/repos/connectionsRepo.js", () => ({
  getProviderConnectionById: async (id) => ({ provider: "codebuddy-cn", providerSpecificData: { codebuddyUid: id === "duplicate" ? "a" : id } }),
}));
const { getCheckinState, updateCheckinState } = await import("../../src/lib/db/repos/checkinRepo.js");
beforeEach(() => { rows.clear(); vi.clearAllMocks(); });

describe("persistent checkin state", () => {
  it("defaults missing state to opt-out", async () => {
    expect(await getCheckinState("a")).toEqual({ enabled: false });
    expect(adapter.run).not.toHaveBeenCalled();
  });
  it("atomically merges a switch with the latest daily markers", async () => {
    await updateCheckinState("a", () => ({ enabled: true }));
    await updateCheckinState("a", () => ({ lastSuccessDate: "2026-10-22", leaseId: null }));
    await updateCheckinState("a", () => ({ enabled: false }));
    expect(await getCheckinState("a")).toEqual({ enabled: false, lastSuccessDate: "2026-10-22", leaseId: null });
    expect(await getCheckinState("b")).toEqual({ enabled: false });
  });
  it("shares UID daily markers while keeping connection switches separate", async () => {
    await updateCheckinState("a", () => ({ enabled: true, lastSuccessDate: "2026-10-22", leaseId: "owner" }));
    expect(await getCheckinState("duplicate")).toEqual({ enabled: false, lastSuccessDate: "2026-10-22", leaseId: "owner" });
    await updateCheckinState("duplicate", () => ({ enabled: true }));
    await updateCheckinState("a", () => ({ enabled: false }));
    expect((await getCheckinState("duplicate")).enabled).toBe(true);
    expect(adapter.flush).toHaveBeenCalled();
  });
  it("propagates flush failures instead of reporting a durable lease", async () => {
    adapter.flush.mockImplementationOnce(() => { throw new Error("disk unavailable"); });
    await expect(updateCheckinState("a", () => ({ leaseId: "owner" }))).rejects.toThrow("disk unavailable");
  });
  it("a no-op updater cannot write or overwrite the state", async () => {
    await updateCheckinState("a", () => ({ enabled: true }));
    adapter.run.mockClear();
    expect(await updateCheckinState("a", () => null)).toEqual({ enabled: true });
    expect(adapter.run).not.toHaveBeenCalled();
  });
  it.each(["{broken", "null", "[]", '"string"'])("fails closed on corrupted persisted markers: %s", async (value) => {
    rows.set("codebuddyCheckin:account:codebuddy-cn:a", value);
    await expect(getCheckinState("a")).rejects.toThrow("Invalid check-in state");
    await expect(updateCheckinState("a", () => ({ enabled: true }))).rejects.toThrow();
    expect(rows.get("codebuddyCheckin:account:codebuddy-cn:a")).toBe(value);
    expect(adapter.run).not.toHaveBeenCalled();
  });
});
