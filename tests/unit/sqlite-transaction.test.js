import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isSqliteBusy, runSqliteTransaction } from "../../runtime/sqlite-transaction.mjs";

const databases = [];
const directories = [];

function openDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sm-transaction-"));
  const file = path.join(dir, "data.sqlite");
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=0; CREATE TABLE entries(id INTEGER PRIMARY KEY, value TEXT);");
  databases.push(db);
  directories.push(dir);
  return { db, file };
}

afterEach(() => {
  vi.restoreAllMocks();
  while (databases.length) {
    const db = databases.pop();
    if (db.isTransaction) db.exec("ROLLBACK");
    db.close();
  }
  while (directories.length) fs.rmSync(directories.pop(), { recursive: true, force: true });
});

describe("SQLite transaction boundaries", () => {
  it("rolls back when COMMIT itself fails instead of leaving an active transaction", () => {
    const { db } = openDb();
    const originalExec = db.exec.bind(db);
    vi.spyOn(db, "exec").mockImplementation((sql) => {
      if (sql === "COMMIT") throw new Error("injected commit failure");
      return originalExec(sql);
    });

    expect(() => runSqliteTransaction(db, () => {
      db.prepare("INSERT INTO entries(id, value) VALUES(1, 'uncommitted')").run();
    })).toThrow("injected commit failure");

    expect(db.isTransaction).toBe(false);
    expect(db.prepare("SELECT count(*) AS n FROM entries").get().n).toBe(0);
    db.prepare("INSERT INTO entries(id, value) VALUES(2, 'next')").run();
    expect(db.prepare("SELECT value FROM entries WHERE id=2").get().value).toBe("next");
  });

  it("forces a full rollback if nested cleanup itself fails", () => {
    const { db } = openDb();
    db.exec("BEGIN IMMEDIATE");
    const originalExec = db.exec.bind(db);
    vi.spyOn(db, "exec").mockImplementation((sql) => {
      if (/^ROLLBACK TO sm_/.test(sql)) throw new Error("injected savepoint cleanup failure");
      return originalExec(sql);
    });
    vi.spyOn(console, "error").mockImplementation(() => {});

    expect(() => runSqliteTransaction(db, () => {
      db.prepare("INSERT INTO entries(id) VALUES(1)").run();
      throw new Error("injected write failure");
    })).toThrow("injected write failure");
    expect(db.isTransaction).toBe(false);
    expect(db.prepare("SELECT count(*) AS n FROM entries").get().n).toBe(0);
  });

  it("rejects async callbacks instead of committing before their writes finish", async () => {
    const { db } = openDb();
    expect(() => runSqliteTransaction(db, async () => {
      db.prepare("INSERT INTO entries(id) VALUES(1)").run();
    })).toThrow("SQLite transaction callback must be synchronous");
    expect(db.isTransaction).toBe(false);
    expect(db.prepare("SELECT count(*) AS n FROM entries").get().n).toBe(0);
  });

  it("takes the write lock before the callback's first read", () => {
    const { db, file } = openDb();
    const competing = new DatabaseSync(file);
    databases.push(competing);
    competing.exec("PRAGMA busy_timeout=0");

    let competingError;
    const result = runSqliteTransaction(db, () => {
      expect(db.prepare("SELECT count(*) AS n FROM entries").get().n).toBe(0);
      try { competing.prepare("INSERT INTO entries(id) VALUES(99)").run(); }
      catch (error) { competingError = error; }
      db.prepare("INSERT INTO entries(id) VALUES(1)").run();
      return "committed";
    });

    expect(result).toBe("committed");
    expect(isSqliteBusy(competingError)).toBe(true);
    expect(db.isTransaction).toBe(false);
    expect(db.prepare("SELECT count(*) AS n FROM entries").get().n).toBe(1);
  });

  it("recognizes SQLite extended busy result codes", () => {
    expect(isSqliteBusy(Object.assign(new Error("database is locked"), { errcode: 517 }))).toBe(true);
    expect(isSqliteBusy(Object.assign(new Error("constraint failed"), { errcode: 19 }))).toBe(false);
  });
});
