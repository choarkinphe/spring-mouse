/**
 * Retention tests.
 *
 * `runtime/usage-writer.mjs` is a standalone process (it calls main() at import
 * time), so it cannot be imported here. These tests exercise the same chunked,
 * index-covered DELETE the writer runs, against a real temp DB, to lock in:
 *   - rows older than the cutoff are removed, newer rows survive
 *   - the delete is chunked (bounded per statement)
 *   - the timestamp index is used (so pruning stays cheap as the table grows)
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let tempDir;
const originalDataDir = process.env.DATA_DIR;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "spring-mouse-retention-"));
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

/** Mirrors usage-writer.mjs pruneOnce() for a single table. */
function pruneChunked(db, table, indexHint, cutoff, chunkSize = 5000) {
  let removed = 0;
  for (;;) {
    const result = db.run(
      `DELETE FROM ${table} WHERE id IN (
         SELECT id FROM ${table} INDEXED BY ${indexHint} WHERE timestamp < ? LIMIT ?
       )`,
      [cutoff, chunkSize],
    );
    const changes = Number(result.changes || 0);
    removed += changes;
    if (changes < chunkSize) break;
  }
  return removed;
}

describe("usage retention pruning", () => {
  it("removes only rows older than the cutoff", async () => {
    const { getAdapter } = await import("../../src/lib/db/driver.js");
    const db = await getAdapter();
    const now = Date.now();
    const iso = (msAgo) => new Date(now - msAgo).toISOString();

    // 5 old (100 days), 5 recent (10 days)
    for (let i = 0; i < 5; i++) {
      db.run(
        `INSERT INTO usageHistory(timestamp, provider, model, apiKeyId, requestId, startedAt, completedAt, promptTokens, completionTokens, status, tokens, meta)
         VALUES(?, 'p', 'm', 'local-no-key', ?, ?, ?, 1, 1, 'success', '{}', '{}')`,
        [iso(100 * 86400e3 + i * 1000), `old-${i}`, iso(100 * 86400e3), iso(100 * 86400e3)],
      );
    }
    for (let i = 0; i < 5; i++) {
      db.run(
        `INSERT INTO usageHistory(timestamp, provider, model, apiKeyId, requestId, startedAt, completedAt, promptTokens, completionTokens, status, tokens, meta)
         VALUES(?, 'p', 'm', 'local-no-key', ?, ?, ?, 1, 1, 'success', '{}', '{}')`,
        [iso(10 * 86400e3 + i * 1000), `new-${i}`, iso(10 * 86400e3), iso(10 * 86400e3)],
      );
    }

    const cutoff = new Date(now - 90 * 86400e3).toISOString();
    const removed = pruneChunked(db, "usageHistory", "idx_uh_ts", cutoff);

    expect(removed).toBe(5);
    const remaining = db.all("SELECT requestId FROM usageHistory ORDER BY requestId");
    expect(remaining.map((r) => r.requestId)).toEqual(["new-0", "new-1", "new-2", "new-3", "new-4"]);
  });

  it("respects the chunk size (bounded per statement)", async () => {
    const { getAdapter } = await import("../../src/lib/db/driver.js");
    const db = await getAdapter();
    const now = Date.now();
    const iso = (msAgo) => new Date(now - msAgo).toISOString();

    for (let i = 0; i < 25; i++) {
      db.run(
        `INSERT INTO usageHistory(timestamp, provider, model, apiKeyId, requestId, startedAt, completedAt, promptTokens, completionTokens, status, tokens, meta)
         VALUES(?, 'p', 'm', 'local-no-key', ?, ?, ?, 1, 1, 'success', '{}', '{}')`,
        [iso(100 * 86400e3 + i * 1000), `old-${i}`, iso(100 * 86400e3), iso(100 * 86400e3)],
      );
    }

    const cutoff = new Date(now - 90 * 86400e3).toISOString();
    // chunkSize 10 over 25 old rows -> 3 statements, all removed
    const removed = pruneChunked(db, "usageHistory", "idx_uh_ts", cutoff, 10);
    expect(removed).toBe(25);
    expect(db.get("SELECT COUNT(*) c FROM usageHistory").c).toBe(0);
  });

  it("prunes networkTraffic on the same cutoff", async () => {
    const { getAdapter } = await import("../../src/lib/db/driver.js");
    const db = await getAdapter();
    const now = Date.now();
    const iso = (msAgo) => new Date(now - msAgo).toISOString();

    db.run(
      `INSERT INTO networkTraffic(requestId, timestamp, completedAt, method, endpoint, statusCode, requestBytes, responseBytes, durationMs, aborted, meta)
       VALUES('t-old', ?, ?, 'POST', '/x', 200, 1, 1, 1, 0, '{}')`,
      [iso(100 * 86400e3), iso(100 * 86400e3)],
    );
    db.run(
      `INSERT INTO networkTraffic(requestId, timestamp, completedAt, method, endpoint, statusCode, requestBytes, responseBytes, durationMs, aborted, meta)
       VALUES('t-new', ?, ?, 'POST', '/x', 200, 1, 1, 1, 0, '{}')`,
      [iso(10 * 86400e3), iso(10 * 86400e3)],
    );

    const cutoff = new Date(now - 90 * 86400e3).toISOString();
    const removed = pruneChunked(db, "networkTraffic", "idx_nt_ts", cutoff);
    expect(removed).toBe(1);
    expect(db.all("SELECT requestId FROM networkTraffic").map((r) => r.requestId)).toEqual(["t-new"]);
  });

  it("the timestamp index makes the prune an indexed range scan", async () => {
    const { getAdapter } = await import("../../src/lib/db/driver.js");
    const db = await getAdapter();
    const plan = db.all(
      "EXPLAIN QUERY PLAN SELECT id FROM usageHistory INDEXED BY idx_uh_ts WHERE timestamp < ? LIMIT 100",
      [new Date().toISOString()],
    ).map((r) => r.detail || "").join(" | ");
    expect(plan).toContain("idx_uh_ts");
    expect(plan).not.toMatch(/SCAN usageHistory(?! USING)/);
  });
});
