import { createHash, randomBytes, randomUUID } from "node:crypto";
import { getAdapter } from "../driver.js";

const KEY_PREFIX = "smop_";
const LAST_USED_THROTTLE_MS = 60_000;
const lastUsedCache = new Map();

function hashKey(key) {
  return createHash("sha256").update(key).digest("hex");
}

function rowToKey(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    keyPrefix: row.keyPrefix,
    isActive: row.isActive === 1 || row.isActive === true,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    lastUsedAt: row.lastUsedAt || null,
  };
}

export async function getOpenPlatformApiKeys() {
  const db = await getAdapter();
  return db.all(`SELECT id, name, keyPrefix, isActive, createdAt, updatedAt, lastUsedAt FROM openPlatformApiKeys ORDER BY createdAt DESC`).map(rowToKey);
}

export async function getOpenPlatformApiKeyById(id) {
  const db = await getAdapter();
  return rowToKey(db.get(`SELECT id, name, keyPrefix, isActive, createdAt, updatedAt, lastUsedAt FROM openPlatformApiKeys WHERE id = ?`, [id]));
}

export async function createOpenPlatformApiKey(name) {
  const db = await getAdapter();
  const key = `${KEY_PREFIX}${randomBytes(24).toString("base64url")}`;
  const now = new Date().toISOString();
  const record = {
    id: randomUUID(),
    name,
    keyPrefix: key.slice(0, 13),
    isActive: true,
    createdAt: now,
    updatedAt: now,
    lastUsedAt: null,
  };
  db.run(
    `INSERT INTO openPlatformApiKeys(id, name, keyPrefix, keyHash, isActive, createdAt, updatedAt, lastUsedAt) VALUES(?, ?, ?, ?, 1, ?, ?, NULL)`,
    [record.id, record.name, record.keyPrefix, hashKey(key), record.createdAt, record.updatedAt],
  );
  return { ...record, key };
}

export async function updateOpenPlatformApiKey(id, data) {
  const db = await getAdapter();
  const existing = db.get(`SELECT * FROM openPlatformApiKeys WHERE id = ?`, [id]);
  if (!existing) return null;

  const name = data.name === undefined ? existing.name : data.name;
  const isActive = data.isActive === undefined ? existing.isActive === 1 : data.isActive === true;
  const updatedAt = new Date().toISOString();
  db.run(`UPDATE openPlatformApiKeys SET name = ?, isActive = ?, updatedAt = ? WHERE id = ?`, [name, isActive ? 1 : 0, updatedAt, id]);
  return rowToKey({ ...existing, name, isActive: isActive ? 1 : 0, updatedAt });
}

export async function deleteOpenPlatformApiKey(id) {
  const db = await getAdapter();
  const result = db.run(`DELETE FROM openPlatformApiKeys WHERE id = ?`, [id]);
  lastUsedCache.delete(id);
  return (result?.changes || 0) > 0;
}

export async function authenticateOpenPlatformApiKey(key) {
  if (typeof key !== "string" || !key.startsWith(KEY_PREFIX)) return null;
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM openPlatformApiKeys WHERE keyHash = ?`, [hashKey(key)]);
  if (!row || !(row.isActive === 1 || row.isActive === true)) return null;

  const now = Date.now();
  if (now - (lastUsedCache.get(row.id) || 0) > LAST_USED_THROTTLE_MS) {
    const lastUsedAt = new Date(now).toISOString();
    db.run(`UPDATE openPlatformApiKeys SET lastUsedAt = ? WHERE id = ?`, [lastUsedAt, row.id]);
    row.lastUsedAt = lastUsedAt;
    lastUsedCache.set(row.id, now);
  }
  return rowToKey(row);
}
