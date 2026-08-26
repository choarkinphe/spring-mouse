import { createClient } from "redis";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

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
let stopping = false;
let db = null;
let redisClient = null;

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function openDatabase() {
  if (db) return db;
  if (!fs.existsSync(dbFile)) return null;
  const candidate = new DatabaseSync(dbFile);
  candidate.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;");
  const ready = candidate.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='usageHistory'").get();
  if (!ready) { candidate.close(); return null; }
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
    const insertStmt = database.prepare(`INSERT OR IGNORE INTO usageHistory(timestamp, provider, model, connectionId, apiKey, apiKeyId, requestId, startedAt, completedAt, endpoint, promptTokens, completionTokens, cost, status, tokens, meta) VALUES(?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const lastUsedStmt = database.prepare(`UPDATE apiKeys SET lastUsedAt = CASE WHEN lastUsedAt IS NULL OR lastUsedAt < ? THEN ? ELSE lastUsedAt END WHERE id = ?`);
    const metaGet = database.prepare("SELECT value FROM _meta WHERE key = 'totalRequestsLifetime'");
    const metaSet = database.prepare("INSERT INTO _meta(key, value) VALUES('totalRequestsLifetime', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
    let insertedCount = 0;

    for (const event of events) {
      if (!event?.requestId || existingStmt.get(event.requestId)) continue;
      const result = insertStmt.run(
        event.timestamp, event.provider || null, event.model || null, event.connectionId || null,
        event.apiKeyId, event.requestId, event.startedAt, event.completedAt, event.endpoint || null,
        Number(event.promptTokens) || 0, Number(event.completionTokens) || 0, Number(event.cost) || 0,
        event.status || "success", JSON.stringify(event.tokens || {}), JSON.stringify(event.meta || {}),
      );
      if (Number(result.changes || 0) === 0) continue;
      insertedCount++;
      if (event.knownApiKeyId) lastUsedStmt.run(event.completedAt, event.completedAt, event.knownApiKeyId);
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

async function persistWithRetry(client, messages) {
  while (!stopping) {
    try {
      if (await persistAndAck(client, messages)) return true;
    } catch (error) {
      console.error("[UsageWriter] persist failed:", error.message);
    }
    await sleep(500);
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
      if (!messages.length) continue;
      await persistWithRetry(client, messages);
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
