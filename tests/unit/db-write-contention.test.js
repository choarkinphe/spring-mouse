// SQLite write-lock contention — regression tests for the deferred-transaction
// upgrade failure that 500'd PUT /api/providers/:id in production.
//
// Root cause: a transaction that begins deferred takes a read snapshot on its
// first SELECT and only later upgrades to a write lock. If the routing/usage
// writer committed in between, SQLite fails the upgrade immediately with
// SQLITE_BUSY_SNAPSHOT ("database is locked"); busy_timeout is deliberately not
// applied to that case. BEGIN IMMEDIATE takes the write lock up front so
// busy_timeout applies instead.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const [major, minor] = process.versions.node.split(".").map(Number);
const hasNodeSqlite = major > 22 || (major === 22 && minor >= 5);
const HOLDER = new URL("../fixtures/sqlite-lock-holder.mjs", import.meta.url).pathname;

// SQLITE_BUSY / SQLITE_BUSY_SNAPSHOT both report low byte 5 in errcode.
function isBusy(error) {
  const n = Number(error?.errcode);
  if (Number.isFinite(n)) return (n & 0xff) === 5;
  return /database is locked|SQLITE_BUSY/i.test(String(error?.message || ""));
}

// A competing writer attempt that must either win the lock (committed) or fail
// with SQLITE_BUSY — never silently. Rolls itself back if it did take a lock.
function competingWrite(conn, statements) {
  let began = false;
  try {
    conn.exec("BEGIN IMMEDIATE");
    began = true;
    for (const sql of statements) conn.exec(sql);
    conn.exec("COMMIT");
    return { committed: true };
  } catch (error) {
    if (began) { try { conn.exec("ROLLBACK"); } catch {} }
    return { committed: false, error };
  }
}

function spawnHolder(file, holdMs) {
  const child = spawn(process.execPath, ["--no-warnings", HOLDER, file, String(holdMs)], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let buffer = "";
  const waitFor = (event) => new Promise((resolve, reject) => {
    const marker = JSON.stringify({ event });
    const settle = () => {
      if (buffer.includes(marker)) { child.stdout.off("data", onData); resolve(); return true; }
      return false;
    };
    const onData = (chunk) => { buffer += chunk; settle(); };
    if (settle()) return;
    child.stdout.on("data", onData);
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`holder exited early (${code})`)));
  });
  const done = new Promise((resolve) => child.once("exit", resolve));
  return { child, waitFor, done };
}

// ── Adapter semantics on the real node:sqlite adapter ─────────────────────
describe.skipIf(!hasNodeSqlite)("node:sqlite adapter write-lock handling", () => {
  let DatabaseSync;
  let adapter;
  let dir;
  let file;

  beforeAll(async () => {
    ({ DatabaseSync } = await import("node:sqlite"));
    const { createNodeSqliteAdapter } = await import("@/lib/db/adapters/nodeSqliteAdapter.js");
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "sm-write-lock-"));
    file = path.join(dir, "data.sqlite");
    adapter = await createNodeSqliteAdapter(file);
    adapter.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT)");
    adapter.run("INSERT INTO t(id, v) VALUES(1, 'init')");
  });

  afterAll(() => {
    try { adapter?.close?.(); } catch {}
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("holds the write lock up front so a competing commit cannot fail the transaction", () => {
    const external = new DatabaseSync(file);
    external.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=0;");
    try {
      const readValue = adapter.transaction(() => {
        const before = adapter.get("SELECT v FROM t WHERE id = 1");
        // The competing writer commits between our read and our write. Under a
        // deferred transaction it would succeed here (only a read snapshot is
        // held), and the adapter's own write would then fail SQLITE_BUSY_SNAPSHOT.
        const attempt = competingWrite(external, ["UPDATE t SET v = 'external' WHERE id = 1"]);
        expect(attempt.committed).toBe(false);
        expect(isBusy(attempt.error)).toBe(true);
        adapter.run("UPDATE t SET v = 'app' WHERE id = 1");
        return before.v;
      });

      expect(readValue).toBe("init");
      expect(adapter.get("SELECT v FROM t WHERE id = 1").v).toBe("app");
    } finally {
      external.close();
    }
  });

  it("nests via SAVEPOINT: an inner rollback keeps the outer work", () => {
    adapter.transaction(() => {
      adapter.run("INSERT INTO t(id, v) VALUES(10, 'outer-before')");
      expect(() =>
        adapter.transaction(() => {
          adapter.run("INSERT INTO t(id, v) VALUES(11, 'inner')");
          throw new Error("inner failure");
        })
      ).toThrow("inner failure");
      adapter.run("INSERT INTO t(id, v) VALUES(12, 'outer-after')");
    });
    const ids = adapter.all("SELECT id FROM t").map((r) => r.id);
    expect(ids).toContain(10);
    expect(ids).toContain(12);
    expect(ids).not.toContain(11);
  });

  it("rolls back the whole transaction when the outer callback throws", () => {
    expect(() =>
      adapter.transaction(() => {
        adapter.run("INSERT INTO t(id, v) VALUES(20, 'x')");
        adapter.transaction(() => adapter.run("INSERT INTO t(id, v) VALUES(21, 'y')"));
        throw new Error("outer failure");
      })
    ).toThrow("outer failure");
    const ids = adapter.all("SELECT id FROM t").map((r) => r.id);
    expect(ids).not.toContain(20);
    expect(ids).not.toContain(21);
  });

  it("returns the callback's value", () => {
    expect(adapter.transaction(() => 42)).toBe(42);
    expect(adapter.transaction(() => adapter.get("SELECT COUNT(*) AS n FROM t").n)).toBeGreaterThan(0);
  });

  it("recovers nesting state after a failed transaction", () => {
    expect(() => adapter.transaction(() => { throw new Error("boom"); })).toThrow("boom");
    // A following transaction must still open a real BEGIN/COMMIT, not inherit
    // a stale nesting depth from the failed one.
    adapter.transaction(() => adapter.run("INSERT INTO t(id, v) VALUES(30, 'after-error')"));
    expect(adapter.get("SELECT v FROM t WHERE id = 30").v).toBe("after-error");
  });
});

// ── Cross-process: BEGIN IMMEDIATE honors busy_timeout ────────────────────
describe.skipIf(!hasNodeSqlite)("cross-process write-lock wait", () => {
  let createNodeSqliteAdapter;
  let dir;

  beforeAll(async () => {
    ({ createNodeSqliteAdapter } = await import("@/lib/db/adapters/nodeSqliteAdapter.js"));
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "sm-xproc-"));
  });
  afterAll(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

  it("waits for a separate process holding the lock, then commits", async () => {
    const file = path.join(dir, "wait.sqlite");
    const adapter = await createNodeSqliteAdapter(file);
    adapter.exec("CREATE TABLE t(id INTEGER PRIMARY KEY)");
    const holder = spawnHolder(file, 700);
    try {
      await holder.waitFor("locked");
      const start = Date.now();
      // Read then write: a deferred transaction would take a read snapshot and
      // then fail to upgrade once the holder commits (stale snapshot), whereas
      // BEGIN IMMEDIATE blocks on busy_timeout until the holder releases.
      adapter.transaction(() => {
        adapter.get("SELECT COUNT(*) AS n FROM t");
        adapter.run("INSERT INTO t(id) VALUES(1)");
      });
      const elapsed = Date.now() - start;
      expect(elapsed).toBeGreaterThanOrEqual(400);
      expect(adapter.get("SELECT COUNT(*) AS n FROM t").n).toBe(1);
      await holder.done;
    } finally {
      holder.child.kill();
      adapter.close();
    }
  }, 15000);

  it("fails with SQLITE_BUSY once busy_timeout is exhausted, and leaves depth clean", async () => {
    const file = path.join(dir, "exhaust.sqlite");
    const adapter = await createNodeSqliteAdapter(file);
    adapter.exec("PRAGMA busy_timeout=150");
    adapter.exec("CREATE TABLE t(id INTEGER PRIMARY KEY)");
    const holder = spawnHolder(file, 1200);
    try {
      await holder.waitFor("locked");
      let caught;
      try {
        adapter.transaction(() => adapter.run("INSERT INTO t(id) VALUES(1)"));
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeDefined();
      expect(isBusy(caught)).toBe(true);
      // Depth must be clean after the failed transaction: once the holder
      // releases, a fresh transaction still opens a real BEGIN/COMMIT.
      await holder.waitFor("released");
      await holder.done;
      adapter.transaction(() => adapter.run("INSERT INTO t(id) VALUES(2)"));
      expect(adapter.get("SELECT COUNT(*) AS n FROM t").n).toBe(1);
    } finally {
      holder.child.kill();
      adapter.close();
    }
  }, 15000);
});

// ── Real repo path: updateProviderConnection under a competing writer ─────
describe.skipIf(!hasNodeSqlite)("connection update under concurrent writes", () => {
  let dir;
  let originalDataDir;
  let db;
  let adapter;
  let DatabaseSync;

  beforeAll(async () => {
    ({ DatabaseSync } = await import("node:sqlite"));
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "sm-conn-contention-"));
    originalDataDir = process.env.DATA_DIR;
    process.env.DATA_DIR = dir;
    delete global._dbAdapter;
    vi.resetModules();
    db = await import("@/lib/db/index.js");
    const { getAdapter } = await import("@/lib/db/driver.js");
    await db.initDb();
    adapter = await getAdapter();
  });

  afterAll(() => {
    try { adapter?.close?.(); } catch {}
    delete global._dbAdapter;
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
  });

  it("updateProviderConnection succeeds while another connection commits concurrently", async () => {
    const conn = await db.createProviderConnection({
      provider: "contention", authType: "apikey", name: "contention fixture", apiKey: "fixture",
    });

    const file = path.join(dir, "db", "data.sqlite");
    const external = new DatabaseSync(file);
    external.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=0;");
    external.exec("CREATE TABLE IF NOT EXISTS contentionProbe(id INTEGER)");

    // Interleave the competing commit at the adapter's write to
    // providerConnections — after the transaction's read snapshot, before its
    // write — which is exactly where a deferred transaction would lose.
    const originalRun = adapter.run.bind(adapter);
    let injected = false;
    let attempt = null;
    adapter.run = (sql, params) => {
      if (!injected && /providerConnections/i.test(sql) && /INSERT/i.test(sql)) {
        injected = true;
        attempt = competingWrite(external, ["INSERT INTO contentionProbe(id) VALUES(1)"]);
      }
      return originalRun(sql, params);
    };

    try {
      const updated = await db.updateProviderConnection(conn.id, { name: "renamed" });
      expect(updated.name).toBe("renamed");
    } finally {
      adapter.run = originalRun;
      external.close();
    }

    expect(injected).toBe(true);
    expect(attempt.committed).toBe(false);
    expect(isBusy(attempt.error)).toBe(true);
    const after = await db.getProviderConnectionById(conn.id);
    expect(after.name).toBe("renamed");
    expect(after.apiKey).toBe("fixture"); // base fields preserved through the merge
  });
});
