import { describe, expect, it, vi } from "vitest";
import { createTrafficWriter } from "@/lib/networkTrafficWriter.js";

const record = (id) => ({ requestId: id, method: "POST", endpoint: "/v1/responses", timestamp: new Date().toISOString(), meta: {} });
describe("bounded traffic persistence", () => {
  it("keeps one hung write and a bounded waiting queue, then recovers", async () => {
    let release;
    const sink = vi.fn().mockImplementationOnce(() => new Promise(r => { release = r; })).mockResolvedValue(undefined);
    const writer = createTrafficWriter(sink, { maxRecords: 3, maxBytes: 4096 });
    writer.enqueue(record("first"));
    await vi.waitFor(() => expect(sink).toHaveBeenCalledTimes(1));
    for (let i = 0; i < 1000; i++) writer.enqueue(record(`queued-${i}`));
    expect(writer.stats()).toMatchObject({ queued: 3, inFlight: 1, dropped: 997 });
    expect(writer.stats().queuedBytes).toBeLessThanOrEqual(4096);
    release();
    await vi.waitFor(() => expect(writer.stats()).toMatchObject({ queued: 0, inFlight: 0, persisted: 4 }));
    expect(sink.mock.calls.map(([r]) => r.requestId)).toEqual(["first", "queued-997", "queued-998", "queued-999"]);
  });
  it("bounds metadata and retained bytes without keeping the source record", async () => {
    const sink = vi.fn(async () => {});
    const writer = createTrafficWriter(sink, { maxBytes: 8192 });
    const source = { ...record("large"), endpoint: "x".repeat(10000), meta: { appName: "y".repeat(10000), secret: "never-store" } };
    expect(writer.enqueue(source)).toBe(true);
    source.endpoint = "mutated";
    expect(writer.stats().queuedBytes).toBeLessThanOrEqual(8192);
    await vi.waitFor(() => expect(sink).toHaveBeenCalledTimes(1));
    expect(sink.mock.calls[0][0].endpoint).not.toBe("mutated");
    expect(sink.mock.calls[0][0].endpoint.length).toBe(1024);
    expect(sink.mock.calls[0][0].meta.secret).toBeUndefined();
  });
  it("enforces byte capacity independently of record count", async () => {
    const writer = createTrafficWriter(async () => {}, { maxRecords: 256, maxBytes: 4096 });
    for (let i = 0; i < 50; i++) writer.enqueue(record(`byte-${i}`));
    expect(writer.stats().queuedBytes).toBeLessThanOrEqual(4096);
    expect(writer.stats().queued).toBeLessThan(50);
    expect(writer.stats().dropped).toBeGreaterThan(0);
    await vi.waitFor(() => expect(writer.stats()).toMatchObject({ queued: 0, inFlight: 0 }));
  });
  it("continues after a failed write and rate-limits diagnostics", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const sink = vi.fn().mockRejectedValueOnce(new Error("db failure")).mockResolvedValue(undefined);
      const writer = createTrafficWriter(sink);
      writer.enqueue(record("failed")); writer.enqueue(record("ok"));
      await vi.waitFor(() => expect(writer.stats()).toMatchObject({ failed: 1, persisted: 1, queued: 0, inFlight: 0 }));
      expect(warning).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(warning.mock.calls)).not.toContain("db failure");
    } finally { warning.mockRestore(); }
  });
});
