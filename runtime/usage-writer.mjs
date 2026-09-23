import { createClient } from "redis";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { applyEventToRollup, ensureRollupTable } from "./usage-rollup.mjs";
import { applyEventToUserRollup, ensureUserRollupTable } from "./usage-rollup-user.mjs";

const redisUrl = process.env.SPRING_MOUSE_REDIS_URL || "redis://127.0.0.1:6379";
const dataDir = process.env.DATA_DIR || "/app/data";
const dbFile = path.join(dataDir, "db", "data.sqlite");
const stream = "spring-mouse:usage:events";
const group = "sqlite-writers";
const heartbeatKey = "spring-mouse:usage:writer:heartbeat";
const committedChannel = "spring-mouse:usage:committed";
const consumer = `writer-${os.hostname()}-${process.pid}`;
const batchSize = Math.max(1, Number(process.env.SPRING_MOUSE_USAGE_BATCH_SIZE || 100));
const blockMs = Math.max(100, Number(process.env.SPRING_MOUSE_USAGE_BLOCK_MS || 1000));

// Retention: usageHistory and networkTraffic grow ~30k rows/day. The window is
// configurable from the dashboard, so the effective value is read from the
// settings table at prune time (see resolveRetentionDays).
//
// Precedence: the DB setting wins; the env var is kept as a fallback for
// installs that configured it before the setting existed; then the default.
// 0 means "keep forever".
const RETENTION_DAYS_FALLBACK = (() => {
  const raw = process.env.SPRING_MOUSE_USAGE_RETENTION_DAYS;
  if (raw === undefined || raw === "") return 90;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 90;
})();
const PRUNE_INTERVAL_MS = Math.max(60_000, Number(process.env.SPRING_MOUSE_USAGE_PRUNE_INTERVAL_MS || 60 * 60 * 1000));
const PRUNE_CHUNK = Math.max(100, Number(process.env.SPRING_MOUSE_USAGE_PRUNE_CHUNK || 5000));
const lastPruneMetaKey = "usageRetentionLastPruneAt";

let stopping = false;
let db = null;
let redisClient = null;
let lastPruneAt = 0;

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function openDatabase() {
  if (db) return db;
  if (!fs.existsSync(dbFile)) return null;
  const candidate = new DatabaseSync(dbFile);
  candidate.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;");
  const ready = candidate.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='usageHistory'").get();
  const columns = ready ? candidate.prepare("PRAGMA table_info(usageHistory)").all() : [];
  if (!ready || !columns.some((column) => column.name === "trafficRequestId")) { candidate.close(); return null; }
  // The rollup tables are owned by the writer (it is the only thing that writes
  // them), so create them here rather than depending on the web process's
  // migration having run. Idempotent.
  try { ensureRollupTable(candidate); } catch (e) { console.warn("[UsageWriter] rollup table init failed:", e.message); }
  try { ensureUserRollupTable(candidate); } catch (e) { console.warn("[UsageWriter] user rollup table init failed:", e.message); }
  db = candidate;
  return db;
}

function persistBatch(events) {
  const database = openDatabase();
  if (!database) return false;
  const savepoint = `usage_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  database.exec(`SAVEPOINT ${savepoint}`);
  try {
    const existingStmt = database.prepare("SELECT id FROM usageHistory WHERE requestId = ?");
    const insertStmt = database.prepare(`INSERT OR IGNORE INTO usageHistory(timestamp, provider, model, connectionId, apiKey, apiKeyId, requestId, trafficRequestId, startedAt, completedAt, endpoint, promptTokens, completionTokens, cost, status, tokens, meta) VALUES(?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const lastUsedStmt = database.prepare(`UPDATE apiKeys SET lastUsedAt = CASE WHEN lastUsedAt IS NULL OR lastUsedAt < ? THEN ? ELSE lastUsedAt END WHERE id = ?`);
    const metaGet = database.prepare("SELECT value FROM _meta WHERE key = 'totalRequestsLifetime'");
    const metaSet = database.prepare("INSERT INTO _meta(key, value) VALUES('totalRequestsLifetime', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
    let insertedCount = 0;

    for (const event of events) {
      if (!event?.requestId || existingStmt.get(event.requestId)) continue;
      const result = insertStmt.run(
        event.timestamp, event.provider || null, event.model || null, event.connectionId || null,
        event.apiKeyId, event.requestId, event.trafficRequestId || null, event.startedAt, event.completedAt, event.endpoint || null,
        Number(event.promptTokens) || 0, Number(event.completionTokens) || 0, Number(event.cost) || 0,
        event.status || "success", JSON.stringify(event.tokens || {}), JSON.stringify(event.meta || {}),
      );
      if (Number(result.changes || 0) === 0) continue;
      insertedCount++;
      if (event.knownApiKeyId) lastUsedStmt.run(event.completedAt, event.completedAt, event.knownApiKeyId);
      // Rollup accumulates only for rows that actually landed. A re-delivered
      // event reports changes: 0 above and never reaches here, so the rollup
      // stays in step with usageHistory without needing its own dedup.
      applyEventToRollup(database, event);
      // The per-person table is a read-modify-write (sessions and the (user, X)
      // crosses are not SQL increments), so it MUST be fed exactly once per
      // event. The `changes > 0` guard above is what makes that safe.
      applyEventToUserRollup(database, event);
    }

    if (insertedCount > 0) {
      const current = Number.parseInt(metaGet.get()?.value || "0", 10) || 0;
      metaSet.run(String(current + insertedCount));
    }
    database.exec(`RELEASE ${savepoint}`);
    return true;
  } catch (error) {
    try { database.exec(`ROLLBACK TO ${savepoint}`); database.exec(`RELEASE ${savepoint}`); } catch {}
    throw error;
  }
}

/**
 * Resolve the retention window in days.
 *
 * Read from the settings table each time so a dashboard change takes effect on
 * the next prune without restarting this process. Falls back to the env var,
 * then the default, when the row is missing or malformed — a broken read must
 * never silently switch retention off (which would let the tables grow without
 * bound) or to zero.
 */
function resolveRetentionDays(database) {
  try {
    const row = database.prepare(`SELECT data FROM settings WHERE id = 1`).get();
    if (row?.data) {
      const parsed = JSON.parse(row.data);
      const value = parsed?.usageRetentionDays;
      if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
        return Math.floor(value);
      }
    }
  } catch {
    // Fall through to the fallback below.
  }
  return RETENTION_DAYS_FALLBACK;
}

/**
 * Delete rows older than the retention window from both large tables.
 *
 * Chunked + index-covered: each statement deletes at most PRUNE_CHUNK rows via
 * `idx_uh_ts` / `idx_nt_ts` (both on `timestamp`), and we yield to the event loop
 * between chunks. A single unbounded DELETE would hold a long write transaction
 * against the web process (which shares `busy_timeout=5000`).
 *
 * Both tables are pruned at the same cutoff so `usageHistory.trafficRequestId`
 * references do not outlive their `networkTraffic` rows by much.
 */
async function pruneOnce() {
  const database = openDatabase();
  if (!database) return;

  const retentionDays = resolveRetentionDays(database);
  if (!retentionDays) return;

  const cutoff = new Date(Date.now() - retentionDays * 86400_000).toISOString();
  let removed = 0;
  for (const [table, indexHint] of [["usageHistory", "idx_uh_ts"], ["networkTraffic", "idx_nt_ts"]]) {
    for (;;) {
      if (stopping) return;
      const result = database.prepare(
        `DELETE FROM ${table} WHERE id IN (
           SELECT id FROM ${table} INDEXED BY ${indexHint} WHERE timestamp < ? LIMIT ?
         )`,
      ).run(cutoff, PRUNE_CHUNK);
      const changes = Number(result.changes || 0);
      removed += changes;
      if (changes < PRUNE_CHUNK) break;
      // Yield so a big backlog does not starve Redis consumption.
      await sleep(50);
    }
  }
  if (removed > 0) {
    console.log(`[UsageWriter] retention: removed ${removed} row(s) older than ${retentionDays}d`);
    // Reclaim pages only occasionally; a full VACUUM rewrites the file and would
    // block readers, so it is intentionally NOT run here.
  }
  lastPruneAt = Date.now();
  try {
    database.prepare("INSERT INTO _meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(lastPruneMetaKey, String(lastPruneAt));
  } catch { /* meta write is best-effort */ }
}

/** Run retention at most once per interval, resuming the persisted schedule. */
async function maybePrune() {
  // The effective window is resolved inside pruneOnce (it is read from the DB),
  // so there is nothing to short-circuit on here beyond shutdown.
  if (stopping) return;
  if (!lastPruneAt) {
    // First tick after start: honour the persisted timestamp so a restart does
    // not immediately re-run a long prune.
    try {
      const row = openDatabase()?.prepare("SELECT value FROM _meta WHERE key = ?").get(lastPruneMetaKey);
      lastPruneAt = Number.parseInt(row?.value || "0", 10) || 0;
    } catch { lastPruneAt = 0; }
  }
  if (Date.now() - lastPruneAt < PRUNE_INTERVAL_MS) return;
  await pruneOnce();
}

function normalizeMessages(result) {
  if (!result) return [];
  const streams = Array.isArray(result) ? result : [];
  return streams.flatMap((item) => item?.messages || []).map((message) => ({
    id: message.id,
    event: (() => { try { return JSON.parse(message.message?.event || "null"); } catch { return null; } })(),
  })).filter((item) => item.id && item.event);
}

async function persistAndAck(client, messages) {
  if (!messages.length) return true;
  if (!persistBatch(messages.map((item) => item.event))) return false;
  const ids = messages.map((item) => item.id);
  await client.xAck(stream, group, ids);
  await client.xDel(stream, ids);
  await client.publish(committedChannel, JSON.stringify({ count: messages.length, committedAt: Date.now() }));
  return true;
}

// Backoff between persist attempts. The web process writes requestDetails on a
// ~500ms cadence against the same SQLite file, so a fixed 500ms retry kept
// re-colliding with it on the write lock ("database is locked" every ~13s).
// Starting low keeps the common case (a brief overlap) fast, and doubling up to
// a few seconds stops a long holder from being hammered.
const RETRY_MIN_MS = 250;
const RETRY_MAX_MS = 5000;

function isLockError(error) {
  return /database is locked|SQLITE_BUSY/i.test(String(error?.message || error));
}

async function persistWithRetry(client, messages) {
  let delay = RETRY_MIN_MS;
  let collisions = 0;
  while (!stopping) {
    try {
      if (await persistAndAck(client, messages)) {
        // Report recovery once, with the count, so a sustained lock storm is
        // still visible without logging every individual collision.
        if (collisions > 1) {
          console.log(`[UsageWriter] recovered after ${collisions} lock collision(s)`);
        }
        return true;
      }
      delay = RETRY_MIN_MS;
    } catch (error) {
      if (isLockError(error)) {
        // Expected contention with the web process — back off instead of
        // hammering, and stay quiet until we know whether it resolves.
        collisions += 1;
        await sleep(delay);
        delay = Math.min(delay * 2, RETRY_MAX_MS);
        continue;
      }
      console.error("[UsageWriter] persist failed:", error.message);
    }
    await sleep(delay);
  }
  return false;
}

async function recoverPending(client) {
  let start = "0-0";
  do {
    // The supervisor runs exactly one writer. On restart, immediately take over
    // every unacknowledged event left by the previous process.
    const claimed = await client.xAutoClaim(stream, group, consumer, 0, start, { COUNT: batchSize });
    const messages = (claimed?.messages || []).map((message) => ({
      id: message.id,
      event: (() => { try { return JSON.parse(message.message?.event || "null"); } catch { return null; } })(),
    })).filter((item) => item.id && item.event);
    if (messages.length && !await persistWithRetry(client, messages)) return false;
    start = claimed?.nextId || "0-0";
  } while (start !== "0-0" && !stopping);
  return true;
}

async function main() {
  const client = createClient({ url: redisUrl });
  redisClient = client;
  client.on("error", (error) => console.error("[UsageWriter] Redis:", error.message));
  await client.connect();
  try { await client.xGroupCreate(stream, group, "0", { MKSTREAM: true }); } catch (error) {
    if (!String(error?.message || "").includes("BUSYGROUP")) throw error;
  }
  console.log(`[UsageWriter] ready | stream=${stream} | db=${dbFile}`);
  while (!stopping && !await recoverPending(client)) await sleep(500);

  while (!stopping) {
    try {
      await client.set(heartbeatKey, String(Date.now()), { expiration: { type: "EX", value: 20 } });
      const result = await client.xReadGroup(group, consumer, [{ key: stream, id: ">" }], { COUNT: batchSize, BLOCK: blockMs });
      const messages = normalizeMessages(result);
      if (!messages.length) {
        // Idle tick: a natural place to run retention without competing with
        // ingestion. maybePrune() self-throttles to PRUNE_INTERVAL_MS.
        await maybePrune();
        continue;
      }
      await persistWithRetry(client, messages);
      await maybePrune();
    } catch (error) {
      if (!stopping) {
        console.error("[UsageWriter] batch failed:", error.message);
        await sleep(500);
      }
    }
  }

  try { if (db) db.close(); } catch {}
  try { await client.quit(); } catch {}
}

for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => {
  stopping = true;
  try { redisClient?.destroy(); } catch {}
});
main().catch((error) => { console.error("[UsageWriter] fatal:", error); process.exit(1); });
