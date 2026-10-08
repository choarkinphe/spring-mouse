import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  db: { transaction: vi.fn(), get: vi.fn(), run: vi.fn() },
  cache: vi.fn(async () => true), invalidate: vi.fn(),
}));
vi.mock("@/lib/db/driver.js", () => ({ getAdapter: async () => mocks.db }));
vi.mock("@/lib/apiKeyQuotaCache.js", () => ({ invalidateQuotaCache: mocks.invalidate }));
vi.mock("@/lib/redis/hotCache.js", () => ({ setHotJson: mocks.cache, deleteHotJson: vi.fn(), fillHotJson: vi.fn(), getHotJson: vi.fn() }));
const { updateApiKey } = await import("@/lib/db/repos/apiKeysRepo.js");

beforeEach(() => {
  vi.clearAllMocks();
  mocks.db.transaction.mockImplementation((fn) => fn());
  mocks.db.get.mockReturnValue({ id: "id", key: "fake-key", name: "original", machineId: "machine", isActive: 1, quotaMode: "unlimited" });
  mocks.db.run.mockReturnValue({ changes: 1 });
});

describe("API key write contention", () => {
  it("restarts the read/merge transaction on busy and caches only a committed record", async () => {
    mocks.db.run.mockImplementationOnce(() => { throw Object.assign(new Error("database is locked"), { errcode: 517 }); });
    mocks.db.get.mockReturnValueOnce({ id: "id", key: "fake-key", name: "stale", machineId: "machine", isActive: 1, quotaMode: "unlimited" });
    const result = await updateApiKey("id", { rpmLimit: 20 });
    expect(result.name).toBe("original");
    expect(result.rpmLimit).toBe(20);
    expect(mocks.db.get).toHaveBeenCalledTimes(2);
    expect(mocks.db.transaction).toHaveBeenCalledTimes(2);
    expect(mocks.cache).toHaveBeenCalledTimes(1);
  });

  it("bounds busy retries and never caches an uncommitted update", async () => {
    mocks.db.run.mockImplementation(() => { throw new Error("database is locked"); });
    await expect(updateApiKey("id", { name: "new" })).rejects.toThrow("database is locked");
    expect(mocks.db.transaction).toHaveBeenCalledTimes(4);
    expect(mocks.cache).not.toHaveBeenCalled();
  });

  it("does not retry non-lock errors", async () => {
    mocks.db.run.mockImplementationOnce(() => { throw new Error("disk full"); });
    await expect(updateApiKey("id", { name: "new" })).rejects.toThrow("disk full");
    expect(mocks.db.transaction).toHaveBeenCalledTimes(1);
    expect(mocks.cache).not.toHaveBeenCalled();
  });
});
