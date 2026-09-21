import { beforeEach, describe, expect, it, vi } from "vitest";

// A stateful in-memory Redis stand-in that understands SET (with EX/NX), GET and
// DEL, so the read-through/invalidation interleavings below behave like the real
// server instead of a stub that always says "OK".
function createFakeRedis() {
  const store = new Map(); // key -> { value, expiresAt }
  const now = () => Date.now();
  const live = (key) => {
    const entry = store.get(key);
    if (!entry) return null;
    if (entry.expiresAt && entry.expiresAt <= now()) { store.delete(key); return null; }
    return entry;
  };
  return {
    store,
    get: vi.fn(async (key) => live(key)?.value ?? null),
    set: vi.fn(async (key, value, options = {}) => {
      if (options.condition === "NX" && live(key)) return null;
      const ttlSeconds = Number(options.EX);
      store.set(key, {
        value,
        expiresAt: Number.isFinite(ttlSeconds) && ttlSeconds > 0 ? now() + ttlSeconds * 1000 : 0,
      });
      return "OK";
    }),
    del: vi.fn(async (key) => { store.delete(key); return 1; }),
    incr: vi.fn(async () => 1),
    expire: vi.fn(async () => 1),
  };
}

const client = createFakeRedis();

vi.mock("../../src/lib/redis/routingClient.js", () => ({
  routingRedis: async (fn) => { try { return await fn(client); } catch { return null; } },
}));

const hotCache = await import("../../src/lib/redis/hotCache.js");

describe("hot cache invalidation race", () => {
  beforeEach(() => {
    client.store.clear();
    vi.clearAllMocks();
  });

  it("a read-through fill cannot resurrect a snapshot that was invalidated mid-read", async () => {
    const key = "kv:customModels";
    const redisKey = "spring-mouse:hot:v1:kv:customModels";

    // Reader starts: cache miss, so it reads the DB and gets a pre-write snapshot.
    expect(await hotCache.getHotJson(key)).toBeNull();
    const staleSnapshot = { "cx|old-model|llm": { id: "old-model" } };

    // A writer commits a sync and invalidates the key while the reader is still
    // between its DB read and its cache fill.
    await hotCache.deleteHotJson(key);

    // Reader lands its (now stale) fill. This is the exact step that used to
    // clobber the invalidation and make a just-synced model list "flash and vanish".
    await hotCache.fillHotJson(key, staleSnapshot, 120);

    // The stale snapshot must NOT have been cached: the next read falls through
    // to the database and rebuilds.
    expect(await hotCache.getHotJson(key)).toBeNull();
    expect(client.store.get(redisKey)?.value).not.toContain("old-model");
  });

  it("a fill that started after the write still populates the cache", async () => {
    const key = "kv:customModels";

    await hotCache.deleteHotJson(key);
    const freshSnapshot = { "cx|new-model|llm": { id: "new-model" } };
    await hotCache.fillHotJson(key, freshSnapshot, 120);

    // Once the invalidation marker expires the fill is no longer blocked; the
    // marker is short-lived precisely so the hot path cannot stay cold.
    client.store.clear();
    await hotCache.fillHotJson(key, freshSnapshot, 120);
    expect(await hotCache.getHotJson(key)).toEqual(freshSnapshot);
  });

  it("an authoritative write always wins over a pending invalidation", async () => {
    const key = "settings";
    await hotCache.deleteHotJson(key);
    await hotCache.setHotJson(key, { requireLogin: false }, 120);
    expect(await hotCache.getHotJson(key)).toEqual({ requireLogin: false });
  });

  it("treats an invalidation marker as a cache miss, not a value", async () => {
    const key = "kv:modelAliases";
    await hotCache.deleteHotJson(key);
    expect(await hotCache.getHotJson(key)).toBeNull();
  });

  it("still fails open when Redis is unavailable", async () => {
    const get = client.get.getMockImplementation();
    client.get.mockRejectedValueOnce(new Error("offline"));
    expect(await hotCache.getHotJson("settings")).toBeNull();
    client.get.mockImplementation(get);
  });
});
