import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";
import { deleteHotJson } from "@/lib/redis/hotCache.js";

const SCOPE = "modelSyncSnapshots";
const cacheKey = `kv:${SCOPE}`;

export async function getModelSyncSnapshots() {
  const db = await getAdapter();
  const rows = db.all(`SELECT key, value FROM kv WHERE scope = ?`, [SCOPE]);
  return Object.fromEntries(rows.map((row) => [row.key, parseJson(row.value, null)]).filter(([, value]) => value));
}

export async function getModelSyncSnapshot(providerId) {
  if (!providerId) return null;
  const db = await getAdapter();
  const row = db.get(`SELECT value FROM kv WHERE scope = ? AND key = ?`, [SCOPE, providerId]);
  return row ? parseJson(row.value, null) : null;
}

export function buildModelSyncSnapshot({ providerId, providerAlias, connectionId, scope, models, syncedAt = new Date().toISOString() }) {
  if (!providerId || !providerAlias || !connectionId || !["public", "account"].includes(scope) || !Array.isArray(models)) {
    throw new Error("Invalid model sync snapshot");
  }
  const modelIds = [...new Set(models.map((model) => typeof model === "string" ? model : model?.id).filter((id) => typeof id === "string" && id.trim()))];
  return { providerId, providerAlias, status: "success", source: "official", scope, connectionId, syncedAt, count: modelIds.length, modelIds };
}

// May be called inside an existing database transaction (model sync uses this
// to make the authoritative rows and their marker commit atomically).
export function recordModelSyncSnapshotInDb(db, input) {
  const snapshot = buildModelSyncSnapshot(input);
  db.run(`INSERT INTO kv(scope, key, value) VALUES(?, ?, ?) ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value`, [SCOPE, snapshot.providerId, stringifyJson(snapshot)]);
  return snapshot;
}

export async function recordModelSyncSnapshot(input) {
  const db = await getAdapter();
  const snapshot = recordModelSyncSnapshotInDb(db, input);
  db.flush?.();
  await deleteHotJson(cacheKey).catch(() => {});
  return snapshot;
}

export { SCOPE as MODEL_SYNC_SNAPSHOT_SCOPE };
