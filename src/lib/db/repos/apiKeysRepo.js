import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";

function normalizeQuotaMode(mode) {
  return ["off", "limited", "unlimited"].includes(mode) ? mode : "unlimited";
}

function rowToKey(row) {
  if (!row) return null;
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    machineId: row.machineId,
    isActive: row.isActive === 1 || row.isActive === true,
    quotaMode: normalizeQuotaMode(row.quotaMode),
    quotaResetAt: row.quotaResetAt || null,
    fiveHourQuotaResetAt: row.fiveHourQuotaResetAt || null,
    weeklyQuotaResetAt: row.weeklyQuotaResetAt || null,
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt || null,
  };
}

export async function getApiKeys() {
  const db = await getAdapter();
  const rows = db.all(`SELECT * FROM apiKeys ORDER BY createdAt ASC`);
  return rows.map(rowToKey);
}

export async function getApiKeyById(id) {
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM apiKeys WHERE id = ?`, [id]);
  return rowToKey(row);
}

export async function createApiKey(name, machineId) {
  if (!machineId) throw new Error("machineId is required");
  const db = await getAdapter();
  const { generateApiKeyWithMachine } = await import("@/shared/utils/apiKey");
  const result = generateApiKeyWithMachine(machineId);
  const apiKey = {
    id: uuidv4(),
    name,
    key: result.key,
    machineId,
    isActive: true,
    quotaMode: "unlimited",
    quotaResetAt: null,
    fiveHourQuotaResetAt: null,
    weeklyQuotaResetAt: null,
    createdAt: new Date().toISOString(),
    lastUsedAt: null,
  };
  const createdAtMs = new Date(apiKey.createdAt).getTime();
  apiKey.fiveHourQuotaResetAt = new Date(createdAtMs + 5 * 60 * 60 * 1000).toISOString();
  apiKey.weeklyQuotaResetAt = new Date(createdAtMs + 7 * 24 * 60 * 60 * 1000).toISOString();
  db.run(
    `INSERT INTO apiKeys(id, key, name, machineId, isActive, quotaMode, quotaResetAt, fiveHourQuotaResetAt, weeklyQuotaResetAt, createdAt, lastUsedAt) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [apiKey.id, apiKey.key, apiKey.name, apiKey.machineId, 1, apiKey.quotaMode, apiKey.quotaResetAt, apiKey.fiveHourQuotaResetAt, apiKey.weeklyQuotaResetAt, apiKey.createdAt, apiKey.lastUsedAt]
  );
  return apiKey;
}

export async function updateApiKey(id, data) {
  const db = await getAdapter();
  let result = null;
  db.transaction(() => {
    const row = db.get(`SELECT * FROM apiKeys WHERE id = ?`, [id]);
    if (!row) return;
    const merged = { ...rowToKey(row), ...data };
    const quotaMode = normalizeQuotaMode(merged.quotaMode);
    // `off` replaces the legacy standalone enable/disable switch: a closed key
    // must not authenticate, while either usable mode reactivates it.
    const isActive = data.quotaMode !== undefined ? quotaMode !== "off" : merged.isActive;
    db.run(
      `UPDATE apiKeys SET key = ?, name = ?, machineId = ?, isActive = ?, quotaMode = ?, quotaResetAt = ?, fiveHourQuotaResetAt = ?, weeklyQuotaResetAt = ?, lastUsedAt = ? WHERE id = ?`,
      [merged.key, merged.name, merged.machineId, isActive ? 1 : 0, quotaMode, merged.quotaResetAt || null, merged.fiveHourQuotaResetAt || null, merged.weeklyQuotaResetAt || null, merged.lastUsedAt || null, id]
    );
    result = { ...merged, quotaMode, isActive };
  });
  return result;
}

export async function deleteApiKey(id) {
  const db = await getAdapter();
  const res = db.run(`DELETE FROM apiKeys WHERE id = ?`, [id]);
  return (res?.changes ?? 0) > 0;
}

export async function validateApiKey(key) {
  const db = await getAdapter();
  const row = db.get(`SELECT id, isActive, quotaMode FROM apiKeys WHERE key = ?`, [key]);
  const isActive = row?.isActive === 1 || row?.isActive === true;
  if (!isActive || normalizeQuotaMode(row.quotaMode) === "off") return false;

  // `validateApiKey` is the common successful-auth path, so it doubles as the
  // lightweight audit point for the credentials page. Keep the value in UTC
  // ISO format so the UI can render an absolute or relative timestamp safely.
  db.run(`UPDATE apiKeys SET lastUsedAt = ? WHERE id = ?`, [new Date().toISOString(), row.id]);
  return true;
}
