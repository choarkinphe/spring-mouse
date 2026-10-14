// Built-in node:sqlite adapter — available in Node >= 22.5.0.
// No native build, no npm install. API mirrors betterSqliteAdapter.
import { PRAGMA_SQL } from "../schema.js";

export async function createNodeSqliteAdapter(filePath) {
  // Suppress "ExperimentalWarning: SQLite is an experimental feature" from node:sqlite.
  // Stable enough for production use as of Node 22.x (RC quality).
  const origEmit = process.emit;
  process.emit = function (name, data, ...rest) {
    if (name === "warning" && data?.name === "ExperimentalWarning" && /SQLite/i.test(data.message || "")) {
      return false;
    }
    return origEmit.call(process, name, data, ...rest);
  };

  // Dynamic import — fails on Node < 22.5 → driver.js falls back to sql.js
  const sqlite = await import("node:sqlite");
  const Database = sqlite.DatabaseSync;
  const db = new Database(filePath);

  db.exec(PRAGMA_SQL);

  const stmtCache = new Map();
  function prepare(sql) {
    let stmt = stmtCache.get(sql);
    if (!stmt) {
      stmt = db.prepare(sql);
      stmtCache.set(sql, stmt);
    }
    return stmt;
  }

  // `wal_autocheckpoint` from PRAGMA_SQL handles routine maintenance.
  // Reserve TRUNCATE for shutdown, when it cannot interrupt live requests.

  function gracefulClose() {
    try { db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); } catch {}
    try { stmtCache.clear(); } catch {}
    try { db.close(); } catch {}
  }
  const onShutdown = () => gracefulClose();
  process.once("beforeExit", onShutdown);
  process.once("SIGINT", () => { onShutdown(); process.exit(0); });
  process.once("SIGTERM", () => { onShutdown(); process.exit(0); });

  // 0 = outermost transaction (real BEGIN/COMMIT); >0 = nested SAVEPOINT.
  let txDepth = 0;

  return {
    driver: "node:sqlite",
    run(sql, params = []) {
      const r = prepare(sql).run(...params);
      return { changes: Number(r.changes ?? 0), lastInsertRowid: Number(r.lastInsertRowid ?? 0) };
    },
    get(sql, params = []) {
      return prepare(sql).get(...params);
    },
    all(sql, params = []) {
      return prepare(sql).all(...params);
    },
    iterate(sql, params = []) {
      // Use an uncached statement so concurrent dashboard aggregations can
      // iterate independently without materializing every row in memory.
      return db.prepare(sql).iterate(...params);
    },
    exec(sql) { return db.exec(sql); },
    transaction(fn) {
      const nested = txDepth > 0;
      const name = `sp_${Math.random().toString(36).slice(2)}`;
      // Outermost: BEGIN IMMEDIATE — a deferred txn that reads first cannot
      // upgrade after a concurrent commit (SQLITE_BUSY_SNAPSHOT, no busy_timeout).
      db.exec(nested ? `SAVEPOINT ${name}` : "BEGIN IMMEDIATE");
      txDepth++;
      try {
        const r = fn();
        db.exec(nested ? `RELEASE ${name}` : "COMMIT");
        return r;
      } catch (e) {
        try {
          if (nested) { db.exec(`ROLLBACK TO ${name}`); db.exec(`RELEASE ${name}`); }
          else db.exec("ROLLBACK");
        } catch {}
        throw e;
      } finally {
        txDepth--;
      }
    },
    checkpoint() { try { db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); } catch {} },
    close() {
      gracefulClose();
    },
    raw: db,
  };
}
