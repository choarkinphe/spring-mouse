import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let tempDir;
const originalDataDir = process.env.DATA_DIR;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "spring-mouse-routing-migration-"));
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

describe("routing telemetry migration", () => {
  it("creates isolated routing tables and indexes on a fresh SQLite database", async () => {
    const { getAdapter } = await import("@/lib/db/driver.js");
    const { latestVersion } = await import("@/lib/db/migrations/index.js");
    const db = await getAdapter();
    expect(Number(db.get("SELECT value FROM _meta WHERE key = 'schemaVersion'")?.value)).toBe(latestVersion());
    expect(db.all("SELECT name FROM sqlite_master WHERE type = 'table'").map((row) => row.name)).toEqual(expect.arrayContaining([
      "routingRequests",
      "routingAttempts",
    ]));
    expect(db.all("PRAGMA table_info(routingRequests)").map((row) => row.name)).toEqual(expect.arrayContaining([
      "routingRequestId", "outcome", "completedAt", "terminalReason", "attemptCount", "meta",
    ]));
    expect(db.all("PRAGMA table_info(routingAttempts)").map((row) => row.name)).toEqual(expect.arrayContaining([
      "attemptId", "routingRequestId", "provider", "model", "connectionId", "fallbackReason", "durationMs",
    ]));
    expect(db.all("PRAGMA index_list(routingAttempts)").map((row) => row.name)).toEqual(expect.arrayContaining([
      "idx_ra_provider_model_started",
      "idx_ra_role_outcome_started",
    ]));
    expect(db.all("SELECT name FROM sqlite_master WHERE type = 'table'").map((row) => row.name)).not.toContain("usageHistoryRouting");
  });

  it("recreates the telemetry tables after an older schema stamp without touching usage rows", async () => {
    const { getAdapter } = await import("@/lib/db/driver.js");
    const db = await getAdapter();
    db.run(`INSERT INTO usageHistory(timestamp, provider, model, status, tokens, meta) VALUES(?, ?, ?, ?, ?, ?)`, [
      new Date().toISOString(), "provider", "model", "success", "{}", "{}",
    ]);
    db.run("DROP TABLE IF EXISTS routingAttempts");
    db.run("DROP TABLE IF EXISTS routingRequests");
    db.run("UPDATE _meta SET value = '23' WHERE key = 'schemaVersion'");
    db.close?.();
    delete global._dbAdapter;
    vi.resetModules();

    const { getAdapter: getAdapterAgain } = await import("@/lib/db/driver.js");
    const dbAgain = await getAdapterAgain();
    expect(dbAgain.get("SELECT COUNT(*) AS count FROM routingRequests").count).toBe(0);
    expect(dbAgain.get("SELECT COUNT(*) AS count FROM routingAttempts").count).toBe(0);
    expect(dbAgain.get("SELECT COUNT(*) AS count FROM usageHistory").count).toBe(1);
  });
});
