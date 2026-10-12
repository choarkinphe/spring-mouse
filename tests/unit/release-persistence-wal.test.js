import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readPersistence, reportPersistence } from "../fixtures/release-smoke/read-db.mjs";

afterEach(() => vi.restoreAllMocks());

describe("stopped smoke database verification", () => {
  it.each([
    { usageRows: 11, attempts: 14, completedAttempts: 12, selectedAccounts: 2 },
    { usageRows: 12, attempts: 14, completedAttempts: 11, selectedAccounts: 2 },
    { usageRows: 12, attempts: 14, completedAttempts: 12, selectedAccounts: 1 },
    { usageRows: 0, attempts: 0, completedAttempts: 0, selectedAccounts: 0 },
  ])("reports failing thresholds to stderr without weakening the gate %#", (counts) => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(reportPersistence(counts)).toBe(false);
    const report = JSON.parse(error.mock.calls[0][0]);
    expect(report.check).toBe("smoke-persistence");
    expect(report.counts).toEqual(counts);
    for (const failure of report.failures) expect(failure.actual).toBeLessThan(failure.minimum);
    expect(report.failures.length).toBe(Object.entries({ usageRows: 12, completedAttempts: 12, selectedAccounts: 2 }).filter(([key, min]) => counts[key] < min).length);
    expect(console.log).toHaveBeenCalledWith(JSON.stringify(counts));
  });

  it("keeps the observed failure counts visible to a subprocess caller", () => {
    const moduleUrl = new URL("../fixtures/release-smoke/read-db.mjs", import.meta.url).href;
    const counts = { usageRows: 27, attempts: 8, completedAttempts: 2, selectedAccounts: 2 };
    const code = `import { reportPersistence } from ${JSON.stringify(moduleUrl)}; process.exit(reportPersistence(${JSON.stringify(counts)}) ? 0 : 1);`;
    const result = spawnSync(process.execPath, ["--no-warnings", "--input-type=module", "-e", code], { encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toEqual(counts);
    expect(JSON.parse(result.stderr)).toEqual({
      check: "smoke-persistence", counts,
      failures: [{ metric: "completedAttempts", actual: 2, minimum: 12 }],
    });
  });

  it("retains the successful count format and exact passing boundary", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const counts = { usageRows: 12, attempts: 12, completedAttempts: 12, selectedAccounts: 2 };
    expect(reportPersistence(counts)).toBe(true);
    expect(log).toHaveBeenCalledWith(JSON.stringify(counts));
    expect(error).not.toHaveBeenCalled();
  });

  it("reads committed schema and rows still in WAL without changing the source", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "smoke-wal-"));
    const db = new DatabaseSync(path.join(dir, "data.sqlite"));
    try {
      db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE usageHistory(id INTEGER); CREATE TABLE routingAttempts(connectionId TEXT, outcome TEXT); INSERT INTO usageHistory VALUES(1); INSERT INTO routingAttempts VALUES('a','valid_terminal'),('b','valid_terminal');");
      const before = fs.readFileSync(path.join(dir, "data.sqlite-wal"));
      expect(readPersistence(dir)).toEqual({ usageRows: 1, attempts: 2, completedAttempts: 2, selectedAccounts: 2 });
      expect(fs.readFileSync(path.join(dir, "data.sqlite-wal"))).toEqual(before);
    } finally { db.close(); fs.rmSync(dir, { recursive: true }); }
  });
});
