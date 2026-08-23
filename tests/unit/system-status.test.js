import { describe, expect, it, vi } from "vitest";
import { createSystemStatusCollector } from "../../src/lib/system/status.js";

describe("system status collector", () => {
  it("reports version, uptime and process resources with CPU calculated between samples", () => {
    const now = vi.fn().mockReturnValueOnce(10_000).mockReturnValueOnce(12_000);
    const cpuUsage = vi.fn()
      .mockReturnValueOnce({ user: 1_000_000, system: 200_000 })
      .mockReturnValueOnce({ user: 1_150_000, system: 300_000 });
    const processRef = {
      cpuUsage,
      uptime: () => 90_061.9,
      memoryUsage: () => ({ rss: 256 * 1024 * 1024, heapUsed: 100, heapTotal: 200 }),
    };
    const osRef = { cpus: () => [{}, {}, {}], loadavg: () => [0.1, 0.2, 0.3] };
    const getStatus = createSystemStatusCollector({ processRef, osRef, getVersion: () => "0.1.0", now });

    const first = getStatus();
    const second = getStatus();

    expect(first).toMatchObject({
      version: "0.1.0",
      uptimeSeconds: 90_061,
      cpu: { processPercent: null, cores: 3, loadAverage: [0.1, 0.2, 0.3] },
      memory: { rssBytes: 256 * 1024 * 1024, heapUsedBytes: 100, heapTotalBytes: 200 },
    });
    expect(second.cpu.processPercent).toBe(12.5);
    expect(second.sampledAt).toBe("1970-01-01T00:00:12.000Z");
  });

  it("clamps invalid elapsed time and never returns a negative CPU percentage", () => {
    const now = vi.fn().mockReturnValueOnce(10_000).mockReturnValueOnce(9_000);
    const cpuUsage = vi.fn()
      .mockReturnValueOnce({ user: 5_000, system: 1_000 })
      .mockReturnValueOnce({ user: 1_000, system: 500 });
    const getStatus = createSystemStatusCollector({
      processRef: {
        cpuUsage,
        uptime: () => 1,
        memoryUsage: () => ({ rss: 1, heapUsed: 1, heapTotal: 1 }),
      },
      osRef: { cpus: () => [], loadavg: () => [] },
      getVersion: () => "x",
      now,
    });

    getStatus();
    expect(getStatus().cpu.processPercent).toBeNull();
  });
});
