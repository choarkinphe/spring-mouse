import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Retention used to run inside every write transaction: each flush held the
 * write lock for a COUNT(*) plus an ordered DELETE on top of the inserts, which
 * collided with the separate usage-writer process ("database is locked" roughly
 * every 13s on the production gateway).
 *
 * The fix hoists the trim out of the write transaction and rate-limits it. These
 * tests pin the observable consequences: writes always land, and trimming still
 * keeps the newest rows.
 */

let tempDir;
const originalDataDir = process.env.DATA_DIR;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "spring-mouse-details-retention-"));
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

function makeDetail(i) {
  return {
    id: `detail-${i}`,
    requestId: `req-${i}`,
    provider: "deepseek",
    model: "deepseek-v4-flash",
    connectionId: "conn-1",
    timestamp: new Date(Date.now() + i * 1000).toISOString(),
    status: "success",
    latency: { ttft: 5, total: 10 },
    tokens: { prompt_tokens: 1, completion_tokens: 2 },
    request: { messages: [{ role: "user", content: `hello ${i}` }] },
    providerRequest: { model: "upstream" },
    providerResponse: { ok: true },
    response: { content: `world ${i}` },
  };
}

// One module graph per test: initDb + settings, then the shared save/read API.
async function setup({ batchSize = 5, maxRecords = 100 } = {}) {
  const db = await import("../../src/lib/db/index.js");
  await db.initDb();
  await db.updateSettings({
    enableObservability: true,
    observabilityBatchSize: batchSize,
    observabilityMaxRecords: maxRecords,
  });
  return db;
}

describe("requestDetails retention", () => {
  it("persists rows across multiple flushes", async () => {
    const db = await setup({ batchSize: 5 });

    for (let i = 0; i < 5; i += 1) await db.saveRequestDetail(makeDetail(i));
    await new Promise((r) => setTimeout(r, 200)); // batchSize reached → immediate flush
    for (let i = 5; i < 10; i += 1) await db.saveRequestDetail(makeDetail(i));
    await new Promise((r) => setTimeout(r, 200));

    // Both batches must be readable — the trim never gates the writes.
    expect((await db.getRequestDetailByRequestId("req-0"))?.requestId).toBe("req-0");
    expect((await db.getRequestDetailByRequestId("req-9"))?.requestId).toBe("req-9");
    expect((await db.getRequestDetailByRequestId("req-4"))?.response?.content).toBe("world 4");
  });

  it("trims down to the cap, keeping the newest rows", async () => {
    const db = await setup({ batchSize: 5, maxRecords: 3 });

    for (let i = 0; i < 5; i += 1) await db.saveRequestDetail(makeDetail(i));
    await new Promise((r) => setTimeout(r, 250));

    // The newest row survives; the oldest was trimmed away.
    expect((await db.getRequestDetailByRequestId("req-4"))?.requestId).toBe("req-4");
    expect(await db.getRequestDetailByRequestId("req-0")).toBeFalsy();
  });

  it("keeps writes when the payloads are large", async () => {
    const db = await setup({ batchSize: 5 });

    // A large providerRequest is the case that made the write transaction slow.
    // Kept under the 128KB field cap so the row is stored whole, not truncated.
    const big = { ...makeDetail(1), providerRequest: { padding: "y".repeat(100_000) } };
    await db.saveRequestDetail(big);
    // Fill the batch (5) so the flush is triggered by the threshold rather than
    // the 500ms timer, which would make this test wait-dependent.
    for (let i = 2; i < 6; i += 1) await db.saveRequestDetail(makeDetail(i));
    await new Promise((r) => setTimeout(r, 250));

    const got = await db.getRequestDetailByRequestId("req-1");
    expect(got?.requestId).toBe("req-1");
    expect(got?.providerRequest?.padding?.length).toBe(100_000);
  });
});
