import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/lib/db/driver.js", () => ({ getAdapter: async () => ({
  all: () => [{ id: "key-a", key: "secret-a", name: "Alice" }, { id: "key-b", key: "secret-b", name: "Bob" }],
}) }));
vi.mock("../../src/lib/db/repos/connectionsRepo.js", () => ({ getProviderConnections: async () => [{ id: "c1", name: "Account one" }] }));
vi.mock("../../src/lib/redis/liveUsage.js", () => ({
  updateActiveFlow: vi.fn(async () => true), getRecentUsageEvents: vi.fn(async () => []),
  enqueueUsageEvent: vi.fn(async () => false), quotaCounterKey: vi.fn(),
}));

let repo;
beforeEach(async () => {
  vi.useFakeTimers();
  vi.resetModules();
  for (const key of ["_pendingRequests", "_pendingTimers", "_statsEmitTimers", "_connectionMapCache", "_apiKeyMapCache", "_statsEmitter"]) delete global[key];
  global._recentRing = { initialized: true, items: [] };
  repo = await import("../../src/lib/db/repos/usageRepo.js");
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });
const start = (id, key = "secret-a") => repo.trackPendingRequest("gpt-test", "codex", "c1", true, false, key, id);
const finish = (id, key = "secret-a") => repo.trackPendingRequest("gpt-test", "codex", "c1", false, false, key, id);
const update = (id, inputTokens, outputTokens) => repo.updatePendingRequestTokens("gpt-test", "codex", "c1", "secret-a", id, { inputTokens, outputTokens, estimated: false });

describe("pending token telemetry", () => {
  it("sums concurrent streams without overwriting and removes only the completed stream", async () => {
    start("one"); start("two"); start("one");
    update("one", 1000, 100); update("two", 2000, 200);
    expect((await repo.getActiveRequests()).activeRequests[0]).toMatchObject({ count: 2, inputTokens: 3000, outputTokens: 300, tokensEstimated: false, apiKey: { id: "key-a", name: "Alice" } });
    finish("one"); finish("one");
    update("one", 99999, 99999);
    expect((await repo.getActiveRequests()).activeRequests[0]).toMatchObject({ count: 1, inputTokens: 2000, outputTokens: 200 });
    finish("two");
    expect((await repo.getActiveRequests()).activeRequests).toEqual([]);
  });

  it("respects API key scope and never exposes credentials", async () => {
    start("a"); start("b", "secret-b"); update("a", 200, 20);
    const scoped = await repo.getActiveRequests(["key-a"]);
    expect(scoped.activeRequests).toHaveLength(1);
    expect(scoped.activeRequests[0].apiKey.id).toBe("key-a");
    expect(JSON.stringify(scoped)).not.toContain("secret-");
    expect((await repo.getActiveRequests([])).activeRequests).toEqual([]);
    finish("a"); finish("b", "secret-b");
  });

  it("allows final authoritative correction and sanitizes invalid counts", async () => {
    start("a"); update("a", 1000, 100);
    update("a", 100, 10);
    expect((await repo.getActiveRequests()).activeRequests[0]).toMatchObject({ inputTokens: 100, outputTokens: 10 });
    update("a", NaN, -20);
    expect((await repo.getActiveRequests()).activeRequests[0]).toMatchObject({ inputTokens: 100, outputTokens: 0 });
  });

  it("keeps a progressing long stream alive and expires stalled telemetry", async () => {
    start("a");
    await vi.advanceTimersByTimeAsync(55000);
    update("a", 100, 10);
    await vi.advanceTimersByTimeAsync(10000);
    expect((await repo.getActiveRequests()).activeRequests).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(51000);
    expect((await repo.getActiveRequests()).activeRequests).toEqual([]);
  });
});
