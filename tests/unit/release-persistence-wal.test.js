import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { readPersistence } from "../fixtures/release-smoke/read-db.mjs";

describe("stopped smoke database verification", () => {
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
