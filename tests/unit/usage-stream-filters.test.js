import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

const statsEmitter = new EventEmitter();
const resolveUsageDashboardScope = vi.fn(async () => ({ apiKeyIds: null }));

const getUsageStats = vi.fn(async () => ({
  totalRequests: 42,
  aggregateMarker: "filtered-stats",
  activeRequests: [],
  recentRequests: [],
  errorProvider: "",
}));

const getActiveRequests = vi.fn(async (apiKeyId) => ({
  activeRequests: [{ account: "test", apiKeyId }],
  recentRequests: [{ model: "filtered-model" }],
  errorProvider: "",
}));

vi.mock("@/lib/usageDb", () => ({
  statsEmitter,
  getUsageStats,
  getActiveRequests,
}));

vi.mock("@/lib/usageDashboardScope", () => ({
  resolveUsageDashboardScope,
}));

const { GET } = await import("../../src/app/api/usage/stream/route.js");

async function createEventReader(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const nextEvent = async () => {
    while (!buffer.includes("\n\n")) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
    }
    const boundary = buffer.indexOf("\n\n");
    const chunk = buffer.slice(0, boundary);
    buffer = buffer.slice(boundary + 2);
    const line = chunk.split("\n").find((item) => item.startsWith("data: "));
    return line ? JSON.parse(line.slice("data: ".length)) : null;
  };

  return { reader, nextEvent };
}

describe("usage stats stream filtering", () => {
  beforeEach(() => {
    statsEmitter.removeAllListeners();
    vi.clearAllMocks();
  });

  it("uses period, date range, API key, and dashboard scope filters for initial stats", async () => {
    const response = await GET(new Request("http://localhost/api/usage/stream?period=7d&startDate=2026-08-01T00%3A00%3A00.000Z&endDate=2026-08-19T23%3A59%3A59.999Z&apiKeyId=key-1&scope=dashboard"));

    expect(response.headers.get("content-type")).toBe("text/event-stream");
    const { reader, nextEvent } = await createEventReader(response);
    const event = await nextEvent();

    expect(getUsageStats).toHaveBeenCalledWith("7d", {
      startDate: "2026-08-01T00:00:00.000Z",
      endDate: "2026-08-19T23:59:59.999Z",
      apiKeyId: "key-1",
      apiKeyIds: null,
    });
    expect(getActiveRequests).not.toHaveBeenCalled();
    expect(event.aggregateMarker).toBe("filtered-stats");

    statsEmitter.emit("update");
    const quickEvent = await nextEvent();
    expect(getActiveRequests).toHaveBeenCalledWith("key-1");
    expect(quickEvent.streamPatch).toBe(true);
    expect(quickEvent.aggregateMarker).toBeUndefined();
    expect(quickEvent.recentRequests).toEqual([{ model: "filtered-model" }]);

    await reader.cancel();
  });

  it("does not apply the persisted tag scope to an unscoped stream", async () => {
    const response = await GET(new Request("http://localhost/api/usage/stream?period=today"));
    const { reader, nextEvent } = await createEventReader(response);
    await nextEvent();

    expect(getUsageStats).toHaveBeenCalledWith("today", {
      startDate: null,
      endDate: null,
      apiKeyId: null,
      apiKeyIds: null,
    });
    expect(resolveUsageDashboardScope).not.toHaveBeenCalled();

    await reader.cancel();
  });

  it("removes listeners when the request signal is aborted", async () => {
    const abortController = new AbortController();
    const response = await GET(new Request("http://localhost/api/usage/stream?period=today", {
      signal: abortController.signal,
    }));
    const { reader, nextEvent } = await createEventReader(response);
    await nextEvent();

    expect(statsEmitter.listenerCount("update")).toBe(1);
    expect(statsEmitter.listenerCount("pending")).toBe(1);

    abortController.abort();

    expect(statsEmitter.listenerCount("update")).toBe(0);
    expect(statsEmitter.listenerCount("pending")).toBe(0);
    await reader.cancel();
  });

  it("coalesces live patches for a client that is not reading", async () => {
    const response = await GET(new Request("http://localhost/api/usage/stream"));
    // Allow async start to finish, but leave the initial snapshot unread.
    await vi.waitFor(() => expect(statsEmitter.listenerCount("pending")).toBe(1));
    for (let i = 1; i <= 100; i++) {
      getActiveRequests.mockResolvedValueOnce({ activeRequests: [], recentRequests: [{ seq: i }], errorProvider: "" });
      statsEmitter.emit("pending");
      await Promise.resolve(); await Promise.resolve();
    }
    const { reader, nextEvent } = await createEventReader(response);
    await nextEvent(); // initial full snapshot
    expect((await nextEvent()).recentRequests).toEqual([{ seq: 100 }]);
    await reader.cancel();
  });

  it("closes a pending read on abort and does not start an already-aborted stream", async () => {
    const abort = new AbortController();
    const response = await GET(new Request("http://localhost/api/usage/stream", { signal: abort.signal }));
    const { reader, nextEvent } = await createEventReader(response);
    await nextEvent();
    const pending = reader.read();
    abort.abort();
    expect(await pending).toEqual({ value: undefined, done: true });
    getUsageStats.mockClear();
    const closed = await GET(new Request("http://localhost/api/usage/stream", { signal: abort.signal }));
    expect(await closed.body.getReader().read()).toEqual({ value: undefined, done: true });
    expect(getUsageStats).not.toHaveBeenCalled();
    expect(statsEmitter.listenerCount("update")).toBe(0);
  });

  it("keeps the latest full snapshot before the latest patch, without queued heartbeats", async () => {
    vi.useFakeTimers();
    let reader;
    try {
      const response = await GET(new Request("http://localhost/api/usage/stream"));
      await vi.advanceTimersByTimeAsync(0);
      for (let seq = 1; seq <= 3; seq++) {
        getUsageStats.mockResolvedValueOnce({ totalRequests: 42 + seq, activeRequests: [], recentRequests: [] });
        statsEmitter.emit("update");
        await vi.advanceTimersByTimeAsync(5_000);
      }
      getActiveRequests.mockResolvedValueOnce({ activeRequests: [], recentRequests: [{ seq: 999 }], errorProvider: "" });
      statsEmitter.emit("pending");
      await vi.advanceTimersByTimeAsync(100_000); // several heartbeat ticks, still no reads
      const events = await createEventReader(response);
      reader = events.reader;
      expect((await events.nextEvent()).totalRequests).toBe(42);
      expect((await events.nextEvent()).totalRequests).toBe(45);
      expect((await events.nextEvent()).recentRequests).toEqual([{ seq: 999 }]);
      await reader.cancel();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      await reader?.cancel();
      vi.useRealTimers();
    }
  });

  it("coalesces aggregate refreshes during request bursts", async () => {
    vi.useFakeTimers();
    try {
      const response = await GET(new Request("http://localhost/api/usage/stream?period=today"));
      const { reader, nextEvent } = await createEventReader(response);
      await nextEvent();
      getUsageStats.mockClear();

      for (let index = 0; index < 10; index += 1) statsEmitter.emit("update");
      await Promise.resolve();

      expect(getUsageStats).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(getUsageStats).toHaveBeenCalledTimes(1);

      await reader.cancel();
    } finally {
      vi.useRealTimers();
    }
  });
});
