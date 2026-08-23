import { ensureDirs, DATA_FILE } from "./paths.js";

// Use global to survive Next.js dev hot-reload (module state resets on reload)
if (!global._dbAdapter) global._dbAdapter = { instance: null, initPromise: null, logged: false, schemaVersion: null, schemaSyncPromise: null };
const state = global._dbAdapter;

async function tryBunSqlite() {
  // Bun runtime only — built-in, no install needed
  if (!process.versions.bun) return null;
  try {
    const { createBunSqliteAdapter } = await import("./adapters/bunSqliteAdapter.js");
    return await createBunSqliteAdapter(DATA_FILE);
  } catch (e) {
    console.warn(`[DB] bun:sqlite unavailable: ${e.message}`);
    return null;
  }
}

// better-sqlite3 已移除：其原生模块在 Next 热重载的模块拆除阶段会触发
// Node 断言崩溃（Statement::~Statement → env != nullptr），导致 dev 进程整体退出。
// Node ≥22.5 使用内置 node:sqlite（同 API、无原生模块、热重载安全）。

async function tryNodeSqlite() {
  // Built-in since Node 22.5.0 — no install needed. Skip under Bun (no node:sqlite).
  if (process.versions.bun) return null;
  const [maj, min] = process.versions.node.split(".").map(Number);
  if (maj < 22 || (maj === 22 && min < 5)) return null;
  try {
    const { createNodeSqliteAdapter } = await import("./adapters/nodeSqliteAdapter.js");
    return await createNodeSqliteAdapter(DATA_FILE);
  } catch (e) {
    console.warn(`[DB] node:sqlite unavailable: ${e.message}`);
    return null;
  }
}

async function trySqlJs() {
  try {
    const { createSqlJsAdapter } = await import("./adapters/sqljsAdapter.js");
    return await createSqlJsAdapter(DATA_FILE);
  } catch (e) {
    console.warn(`[DB] sql.js unavailable: ${e.message}`);
    return null;
  }
}

async function initAdapter() {
  ensureDirs();
  // Order per runtime:
  //   Bun:  bun:sqlite → sql.js
  //   Node: node:sqlite (≥22.5) → sql.js
  let adapter = await tryBunSqlite();
  if (!adapter) adapter = await tryNodeSqlite();
  if (!adapter) adapter = await trySqlJs();
  if (!adapter) throw new Error("[DB] No SQLite driver available (bun/node/sql.js all failed)");

  if (!state.logged) {
    console.log(`[DB] Driver: ${adapter.driver} | file: ${DATA_FILE}`);
    state.logged = true;
  }

  const [{ runMigrationOnce }, { SCHEMA_VERSION }] = await Promise.all([
    import("./migrate.js"),
    import("./schema.js"),
  ]);
  await runMigrationOnce(adapter);
  state.schemaVersion = SCHEMA_VERSION;
  return adapter;
}

async function ensureCurrentSchema(adapter) {
  const { SCHEMA_VERSION } = await import("./schema.js");
  if (state.schemaVersion === SCHEMA_VERSION) return;

  if (!state.schemaSyncPromise) {
    state.schemaSyncPromise = (async () => {
      const { runMigrationOnce } = await import("./migrate.js");
      // A dev-server hot reload may retain the adapter created before a schema
      // change. Force the normal migration flow once so additive columns are
      // available to freshly reloaded route handlers without a manual restart.
      await runMigrationOnce(adapter, { force: true });
      state.schemaVersion = SCHEMA_VERSION;
    })().finally(() => {
      state.schemaSyncPromise = null;
    });
  }

  await state.schemaSyncPromise;
}

export async function getAdapter() {
  if (state.instance) {
    await ensureCurrentSchema(state.instance);
    return state.instance;
  }
  if (!state.initPromise) state.initPromise = initAdapter().then((a) => { state.instance = a; return a; });
  return state.initPromise;
}

export function getAdapterSync() {
  if (!state.instance) throw new Error("[DB] adapter not initialized — await getAdapter() first");
  return state.instance;
}
