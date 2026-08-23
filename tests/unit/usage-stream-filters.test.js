import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

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

  return async function nextEvent() {
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
}

describe("usage stats stream filtering", () => {
  it("uses period, date range, and API key filters for initial stats", async () => {
    const response = await GET(new Request("http://localhost/api/usage/stream?period=7d&startDate=2026-08-01T00%3A00%3A00.000Z&endDate=2026-08-19T23%3A59%3A59.999Z&apiKeyId=key-1"));

    expect(response.headers.get("content-type")).toBe("text/event-stream");
    const nextEvent = await createEventReader(response);
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
    expect(quickEvent.recentRequests).toEqual([{ model: "filtered-model" }]);
  });
});
