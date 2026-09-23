import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * requestDetails keeps two independent limits:
 *   - `observabilityMaxRecords` bounds the row count;
 *   - `requestDetailsRetentionDays` bounds the age.
 * Whichever is hit first wins. These tests pin the age-based half, which is new.
 */

let tempDir;
const originalDataDir = process.env.DATA_DIR;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "spring-mouse-details-age-"));
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
  delete process.env.SPRING_MOUSE_REQUEST_DETAILS_RETENTION_DAYS;
});

function makeDetail(i, ageDays) {
  return {
    id: `detail-${i}`,
    requestId: `req-${i}`,
    provider: "deepseek",
    model: "deepseek-v4-flash",
    connectionId: "conn-1",
    timestamp: new Date(Date.now() - ageDays * 86400_000).toISOString(),
    status: "success",
    latency: {},
    tokens: {},
    request: { messages: [] },
    providerRequest: {},
    providerResponse: {},
    response: {},
  };
}

async function setup({ retentionDays, maxRecords = 100, batchSize = 5 } = {}) {
  const db = await import("../../src/lib/db/index.js");
  await db.initDb();
  await db.updateSettings({
    enableObservability: true,
    observabilityBatchSize: batchSize,
    observabilityMaxRecords: maxRecords,
    ...(retentionDays === undefined ? {} : { requestDetailsRetentionDays: retentionDays }),
  });
  return db;
}

describe("requestDetails age retention", () => {
  it("drops rows older than the configured window and keeps newer ones", async () => {
    const db = await setup({ retentionDays: 7 });

    // 10 days old → past the window; 1 day old → inside it.
    await db.saveRequestDetail(makeDetail(1, 10));
    for (let i = 2; i < 6; i += 1) await db.saveRequestDetail(makeDetail(i, 1));
    await new Promise((r) => setTimeout(r, 250));

    expect(await db.getRequestDetailByRequestId("req-1")).toBeFalsy();
    expect((await db.getRequestDetailByRequestId("req-5"))?.requestId).toBe("req-5");
  });

  it("keeps everything when the window is 0 (no age limit)", async () => {
    const db = await setup({ retentionDays: 0, maxRecords: 100 });

    await db.saveRequestDetail(makeDetail(1, 400));
    for (let i = 2; i < 6; i += 1) await db.saveRequestDetail(makeDetail(i, 1));
    await new Promise((r) => setTimeout(r, 250));

    // Well past any default window, but 0 means "keep forever".
    expect((await db.getRequestDetailByRequestId("req-1"))?.requestId).toBe("req-1");
  });

  it("still applies the record cap alongside the age window", async () => {
    const db = await setup({ retentionDays: 0, maxRecords: 3 });

    // All fresh, so only the count cap can trim them.
    for (let i = 0; i < 5; i += 1) await db.saveRequestDetail(makeDetail(i, 0));
    await new Promise((r) => setTimeout(r, 250));

    const remaining = await db.getRequestDetails({});
    expect(remaining.details.length).toBeLessThanOrEqual(3);
  });

  it("defaults to 30 days when the setting is absent", async () => {
    const db = await setup({ maxRecords: 100 });

    await db.saveRequestDetail(makeDetail(1, 45)); // older than 30d
    await db.saveRequestDetail(makeDetail(2, 10)); // inside 30d
    for (let i = 3; i < 6; i += 1) await db.saveRequestDetail(makeDetail(i, 1));
    await new Promise((r) => setTimeout(r, 250));

    expect(await db.getRequestDetailByRequestId("req-1")).toBeFalsy();
    expect((await db.getRequestDetailByRequestId("req-2"))?.requestId).toBe("req-2");
  });
});
