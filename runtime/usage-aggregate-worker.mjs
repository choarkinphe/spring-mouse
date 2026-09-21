/**
 * Worker entry for usage aggregation.
 *
 * Runs the synchronous SQLite scan off the main event loop. The aggregation
 * itself lives in `./usage-aggregate.mjs` — the SAME file the web process
 * imports for its in-process fallback, so there is exactly one implementation.
 *
 * Protocol:
 *   in : { id, dbFile, period, range, connectionMap, apiKeyMap, providerNodeNameMap, sourceCapture, now }
 *   out: { id, stats }  |  { id, error }
 *
 * The result payload is small (~17KB); raw rows are never sent back, because
 * postMessage of the full result set would block the main thread for seconds.
 *
 * The DB path arrives per task (not via workerData/env) because a pooled worker
 * is long-lived: pinning the path at construction would keep reading the
 * database that was current when the pool started.
 */
import { parentPort } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { runAggregation } from "./usage-aggregate.mjs";

function resolveDbFile(msg) {
  if (msg?.dbFile) return msg.dbFile;
  const dataDir = process.env.DATA_DIR || "/app/data";
  return path.join(dataDir, "db", "data.sqlite");
}

let db = null;
let dbPath = null;

function openDatabase(file) {
  if (db && dbPath === file) return db;
  closeDatabase();
  const candidate = new DatabaseSync(file, { readOnly: true });
  // Read-only connection: WAL readers must not be blocked by the writer, and a
  // long analytical scan must not hold a write lock.
  candidate.exec("PRAGMA busy_timeout=5000; PRAGMA query_only=ON;");
  db = candidate;
  dbPath = file;
  return db;
}

function closeDatabase() {
  try { db?.close(); } catch {}
  db = null;
  dbPath = null;
}

/**
 * Wrap the sync DatabaseSync in the `{ all, get, iterate }` shape the shared
 * core expects (mirrors src/lib/db/adapters/nodeSqliteAdapter.js).
 *
 * `iterate` uses an uncached statement so the cursor is owned by this call.
 */
function makeAdapter(database) {
  return {
    all(sql, params = []) { return database.prepare(sql).all(...params); },
    get(sql, params = []) { return database.prepare(sql).get(...params); },
    iterate(sql, params = []) { return database.prepare(sql).iterate(...params); },
  };
}

parentPort.on("message", (msg) => {
  const { id } = msg || {};
  try {
    const adapter = makeAdapter(openDatabase(resolveDbFile(msg)));
    const stats = runAggregation(adapter, {
      period: msg.period,
      range: msg.range || {},
      connectionMap: msg.connectionMap || {},
      apiKeyMap: msg.apiKeyMap || {},
      providerNodeNameMap: msg.providerNodeNameMap || {},
      sourceCapture: msg.sourceCapture || {},
      now: msg.now ? new Date(msg.now) : new Date(),
    });
    parentPort.postMessage({ id, stats });
  } catch (error) {
    parentPort.postMessage({ id, error: String(error?.message || error) });
  }
});

process.on("SIGTERM", () => { closeDatabase(); process.exit(0); });
process.on("SIGINT", () => { closeDatabase(); process.exit(0); });
