import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let tempDir;
const originalDataDir = process.env.DATA_DIR;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "spring-mouse-traffic-"));
  process.env.DATA_DIR = tempDir;
  delete global._dbAdapter;
  vi.resetModules();
});

afterEach(() => {
  try { global._dbAdapter?.instance?.close?.(); } catch {}
  delete global._dbAdapter;
  fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("traffic repository", () => {
  it("persists request traffic and aggregates range, calendar, and chart totals", async () => {
    const { saveNetworkTraffic, getTrafficBuckets, getTrafficSummary, getTrafficTotals } = await import("../../src/lib/db/repos/trafficRepo.js");
    const now = new Date();
    const old = new Date(now.getTime() - 8 * 24 * 60 * 60 * 1000);

    await saveNetworkTraffic({
      requestId: "traffic-now",
      timestamp: now.toISOString(),
      completedAt: now.toISOString(),
      method: "POST",
      endpoint: "/api/v1/chat/completions",
      statusCode: 200,
      requestBytes: 120,
      responseBytes: 880,
      durationMs: 50,
    });
    await saveNetworkTraffic({
      requestId: "traffic-old",
      timestamp: old.toISOString(),
      completedAt: old.toISOString(),
      method: "GET",
      endpoint: "/api/v1/models",
      statusCode: 200,
      requestBytes: 0,
      responseBytes: 300,
      durationMs: 10,
    });

    expect(await getTrafficTotals()).toEqual({ requests: 2, requestBytes: 120, responseBytes: 1180, totalBytes: 1300 });
    expect(await getTrafficTotals({ startDate: new Date(now.getTime() - 60_000).toISOString(), endDate: new Date(now.getTime() + 60_000).toISOString() }))
      .toEqual({ requests: 1, requestBytes: 120, responseBytes: 880, totalBytes: 1000 });

    const summary = await getTrafficSummary({ recentLimit: 5 });
    expect(summary.today.totalBytes).toBeGreaterThanOrEqual(1000);
    expect(summary.week.totalBytes).toBeGreaterThanOrEqual(1000);
    expect(summary.month.totalBytes).toBeGreaterThanOrEqual(1000);
    expect(summary.recent[0]).toEqual(expect.objectContaining({ requestId: "traffic-now", totalBytes: 1000 }));

    const startTime = now.getTime() - 60 * 60 * 1000;
    const buckets = await getTrafficBuckets({ startTime, endTime: now.getTime() + 1000, bucketMs: 60 * 60 * 1000, bucketCount: 2 });
    expect(buckets.reduce((sum, bucket) => sum + bucket.trafficBytes, 0)).toBe(1000);
  });

  it("filters source IP before pagination and reports the full result count", async () => {
    const { getAdapter } = await import("../../src/lib/db/driver.js");
    const { getUsageDetails } = await import("../../src/lib/db/repos/usageRepo.js");
    const db = await getAdapter();
    const rareIp = "fdbd:dc02:17:604::206";

    for (let index = 0; index < 25; index++) {
      const timestamp = new Date(Date.now() + index * 1000).toISOString();
      const sourceIp = index === 0 ? rareIp : "221.232.240.98";
      db.run(
        `INSERT INTO usageHistory(timestamp, provider, model, apiKeyId, requestId, startedAt, completedAt, promptTokens, completionTokens, status, tokens, meta)
         VALUES(?, 'test', 'test-model', 'local-no-key', ?, ?, ?, 1, 1, 'success', ?, ?)`,
        [timestamp, `source-ip-${index}`, timestamp, timestamp, JSON.stringify({ prompt_tokens: 1, completion_tokens: 1 }), JSON.stringify({ sourceIp })],
      );
    }

    const all = await getUsageDetails({ page: 1, pageSize: 10 });
    expect(all.details).toHaveLength(10);
    expect(all.pagination).toEqual(expect.objectContaining({ totalItems: 25, totalPages: 3, hasNext: true }));

    const filtered = await getUsageDetails({ sourceIp: rareIp, page: 1, pageSize: 10 });
    expect(filtered.details).toHaveLength(1);
    expect(filtered.details[0]).toEqual(expect.objectContaining({ sourceIp: rareIp }));
    expect(filtered.pagination).toEqual(expect.objectContaining({ totalItems: 1, totalPages: 1, hasNext: false }));
  });

  it("links traffic bytes into existing usage request details", async () => {
    const { saveNetworkTraffic } = await import("../../src/lib/db/repos/trafficRepo.js");
    const { saveRequestUsage, getChartData, getUsageDetails, getUsageStats } = await import("../../src/lib/db/repos/usageRepo.js");
    const timestamp = new Date().toISOString();

    await saveNetworkTraffic({
      requestId: "traffic-linked",
      timestamp,
      completedAt: timestamp,
      method: "POST",
      endpoint: "/api/v1/embeddings",
      statusCode: 200,
      requestBytes: 64,
      responseBytes: 256,
    });
    await saveRequestUsage({
      requestId: "usage-linked",
      trafficRequestId: "traffic-linked",
      startedAt: timestamp,
      completedAt: timestamp,
      provider: "openai",
      model: "text-embedding-3-small",
      endpoint: "/api/v1/embeddings",
      status: "success",
      tokens: { prompt_tokens: 5, completion_tokens: 0 },
    });

    const result = await getUsageDetails({ page: 1, pageSize: 10 });
    expect(result.details[0]).toEqual(expect.objectContaining({
      model: "text-embedding-3-small",
      requestBytes: 64,
      responseBytes: 256,
      totalBytes: 320,
    }));

    const stats = await getUsageStats("today");
    expect(stats).toEqual(expect.objectContaining({
      totalRequestBytes: 64,
      totalResponseBytes: 256,
      totalTrafficBytes: 320,
    }));
    expect(stats.recentCallDetails[0]).toEqual(expect.objectContaining({
      requestBytes: 64,
      responseBytes: 256,
      totalBytes: 320,
    }));
    expect(stats.last10Minutes.reduce((sum, bucket) => sum + bucket.trafficBytes, 0)).toBe(320);
    const chart = await getChartData("today", {
      startDate: new Date(Date.now() - 60_000).toISOString(),
      endDate: new Date(Date.now() + 60_000).toISOString(),
    });
    expect(chart.reduce((sum, bucket) => sum + bucket.trafficBytes, 0)).toBe(320);
  });

});
