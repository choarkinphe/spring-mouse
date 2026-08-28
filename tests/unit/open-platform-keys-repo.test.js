import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ rows: [] }));

const adapter = vi.hoisted(() => ({
  all: vi.fn(() => [...state.rows]),
  get: vi.fn((sql, params) => {
    if (sql.includes("keyHash = ?")) return state.rows.find((row) => row.keyHash === params[0]) || null;
    if (sql.includes("id = ?")) return state.rows.find((row) => row.id === params[0]) || null;
    return null;
  }),
  run: vi.fn((sql, params) => {
    if (sql.startsWith("INSERT INTO openPlatformApiKeys")) {
      const [id, name, keyPrefix, keyHash, createdAt, updatedAt] = params;
      state.rows.push({ id, name, keyPrefix, keyHash, isActive: 1, createdAt, updatedAt, lastUsedAt: null });
      return { changes: 1 };
    }
    if (sql.startsWith("UPDATE openPlatformApiKeys SET name")) {
      const [name, isActive, updatedAt, id] = params;
      const row = state.rows.find((item) => item.id === id);
      if (!row) return { changes: 0 };
      Object.assign(row, { name, isActive, updatedAt });
      return { changes: 1 };
    }
    if (sql.startsWith("UPDATE openPlatformApiKeys SET lastUsedAt")) {
      const [lastUsedAt, id] = params;
      const row = state.rows.find((item) => item.id === id);
      if (row) row.lastUsedAt = lastUsedAt;
      return { changes: row ? 1 : 0 };
    }
    if (sql.startsWith("DELETE FROM openPlatformApiKeys")) {
      const index = state.rows.findIndex((item) => item.id === params[0]);
      if (index === -1) return { changes: 0 };
      state.rows.splice(index, 1);
      return { changes: 1 };
    }
    return { changes: 0 };
  }),
}));

vi.mock("@/lib/db/driver.js", () => ({ getAdapter: vi.fn(async () => adapter) }));

const {
  authenticateOpenPlatformApiKey,
  createOpenPlatformApiKey,
  deleteOpenPlatformApiKey,
  getOpenPlatformApiKeys,
  updateOpenPlatformApiKey,
} = await import("@/lib/db/repos/openPlatformKeysRepo.js");

describe("open platform API key repository", () => {
  beforeEach(() => {
    state.rows.length = 0;
    vi.clearAllMocks();
  });

  it("stores only a hash and reveals the secret once on creation", async () => {
    const created = await createOpenPlatformApiKey("BI integration");
    const stored = state.rows[0];

    expect(created.key).toMatch(/^smop_[A-Za-z0-9_-]+$/);
    expect(created.keyPrefix).toBe(created.key.slice(0, 13));
    expect(stored.keyHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(stored)).not.toContain(created.key);
    expect(await getOpenPlatformApiKeys()).toEqual([expect.objectContaining({ name: "BI integration", keyPrefix: created.keyPrefix })]);
  });

  it("authenticates an active key and rejects a disabled key", async () => {
    const created = await createOpenPlatformApiKey("Report reader");

    await expect(authenticateOpenPlatformApiKey(created.key)).resolves.toMatchObject({ id: created.id, isActive: true });
    await updateOpenPlatformApiKey(created.id, { isActive: false });
    await expect(authenticateOpenPlatformApiKey(created.key)).resolves.toBeNull();
  });

  it("deletes credentials immediately", async () => {
    const created = await createOpenPlatformApiKey("Temporary");

    await expect(deleteOpenPlatformApiKey(created.id)).resolves.toBe(true);
    await expect(authenticateOpenPlatformApiKey(created.key)).resolves.toBeNull();
  });
});
