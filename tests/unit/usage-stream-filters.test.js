import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

const statsEmitter = new EventEmitter();

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

  it("uses period, date range, and API key filters for initial stats", async () => {
    const response = await GET(new Request("http://localhost/api/usage/stream?period=7d&startDate=2026-08-01T00%3A00%3A00.000Z&endDate=2026-08-19T23%3A59%3A59.999Z&apiKeyId=key-1"));

    expect(response.headers.get("content-type")).toBe("text/event-stream");
    const { reader, nextEvent } = await createEventReader(response);
    const event = await nextEvent();

    expect(getUsageStats).toHaveBeenCalledWith("7d", {
      startDate: "2026-08-01T00:00:00.000Z",
      endDate: "2026-08-19T23:59:59.999Z",
      apiKeyId: "key-1",
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
      await vi.advanceTimersByTimeAsync(2_000);
      expect(getUsageStats).toHaveBeenCalledTimes(1);

      await reader.cancel();
    } finally {
      vi.useRealTimers();
    }
  });
});
