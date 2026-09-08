import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
let apply, clear, stats;
beforeEach(async () => {
  vi.useFakeTimers(); vi.resetModules();
  vi.doMock("../../open-sse/config/runtimeConfig.js", () => ({ MEMORY_CONFIG: {
    sessionTtlMs: 100, sessionCleanupIntervalMs: 50,
    kiroSessionMaxBytes: 16 * 1024, kiroSessionMaxEntryBytes: 8 * 1024,
  } }));
  const module = await import("../../open-sse/utils/kiroSessionReplay.js");
  apply = module.applyKiroSessionReplay; clear = module.clearKiroSessionReplayStore; stats = module.__test__?.cacheStats;
});
afterEach(() => { clear?.(); vi.clearAllTimers(); vi.useRealTimers(); });
const input = (id, content = "x".repeat(2000)) => ({ conversationId: id, connectionId: "c", modelId: "m", currentMessage: { userInputMessage: { content } } });
describe("Kiro replay retained-byte budget", () => {
  it("bounds total payload bytes across high-cardinality sessions", () => {
    for (let i = 0; i < 100; i++) apply(input(`session-${i}`));
    expect(stats().bytes).toBeLessThanOrEqual(16 * 1024);
    expect(stats().entries).toBeLessThan(5);
    expect(apply(input("session-99")).replayed).toBe(true);
    expect(apply(input("session-0")).replayed).toBe(false);
  });
  it("skips oversized caching without truncating the outbound message", () => {
    const request = input("large", "你好".repeat(10_000));
    const result = apply(request);
    expect(result.currentMessage.userInputMessage.content).toBe(request.currentMessage.userInputMessage.content);
    expect(stats()).toMatchObject({ bytes: 0, entries: 0 });
  });
  it("releases bytes on replacement, expiration and clear", async () => {
    apply(input("one"));
    const bytes = stats().bytes;
    apply({ ...input("one"), modelId: "another" });
    expect(stats().bytes).toBeLessThan(bytes + 100);
    await vi.advanceTimersByTimeAsync(101);
    expect(stats()).toMatchObject({ bytes: 0, entries: 0 });
    apply(input("two")); clear();
    expect(stats()).toMatchObject({ bytes: 0, entries: 0 });
  });
  it("does not let caller mutation change a cached frozen first message", () => {
    const result = apply(input("stable", "original"));
    result.currentMessage.userInputMessage.content = "mutated";
    const next = apply(input("stable", "next turn"));
    expect(next.replayed).toBe(true);
    expect(next.history[0].userInputMessage.content).toBe("original");
    expect(next.currentMessage.userInputMessage.content).toBe("next turn");
  });
});
