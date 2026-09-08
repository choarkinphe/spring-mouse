import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";
import { deleteHotJson, getHotJson, setHotJson } from "@/lib/redis/hotCache.js";

function rowToCombo(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    models: parseJson(row.models, []),
    isActive: row.isActive !== 0,
    groupName: row.groupName || null,
    sortOrder: Number.isFinite(row.sortOrder) ? row.sortOrder : 0,
    capabilities: parseJson(row.capabilities, {}),
    accessTags: parseJson(row.accessTags, []),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

const COMBOS_CACHE_KEY = "combos";
const COMBOS_CACHE_TTL_SECONDS = 120;

function comboCacheKey(name) {
  return `combo:${name}`;
}

export async function getCombos() {
  const cached = await getHotJson(COMBOS_CACHE_KEY);
  if (Array.isArray(cached)) return cached;
  const db = await getAdapter();
  const combos = db.all(`SELECT * FROM combos ORDER BY COALESCE(groupName, '') ASC, sortOrder ASC, createdAt ASC`).map(rowToCombo);
  setHotJson(COMBOS_CACHE_KEY, combos, COMBOS_CACHE_TTL_SECONDS).catch(() => {});
  return combos;
}

export async function getComboById(id) {
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM combos WHERE id = ?`, [id]);
  return rowToCombo(row);
}

export async function getComboByName(name) {
  const cachedCombo = await getHotJson(comboCacheKey(name));
  if (cachedCombo && typeof cachedCombo === "object") return cachedCombo;
  const cached = await getHotJson(COMBOS_CACHE_KEY);
  if (Array.isArray(cached)) {
    const result = cached.find((combo) => combo.name === name) || null;
    if (result) setHotJson(comboCacheKey(name), result, COMBOS_CACHE_TTL_SECONDS).catch(() => {});
    return result;
  }
  const db = await getAdapter();
  const result = rowToCombo(db.get(`SELECT * FROM combos WHERE name = ?`, [name]));
  if (result) setHotJson(comboCacheKey(name), result, COMBOS_CACHE_TTL_SECONDS).catch(() => {});
  return result;
}

export async function createCombo(data) {
  const db = await getAdapter();
  const now = new Date().toISOString();
  const combo = {
    id: uuidv4(),
    name: data.name,
    kind: data.kind || null,
    models: data.models || [],
    isActive: data.isActive !== false,
    groupName: data.groupName || null,
    sortOrder: Number.isFinite(data.sortOrder) ? data.sortOrder : 0,
    capabilities: data.capabilities || {},
    accessTags: data.accessTags || [],
    createdAt: now,
    updatedAt: now,
  };
  db.run(
    `INSERT INTO combos(id, name, kind, models, isActive, groupName, sortOrder, capabilities, accessTags, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [combo.id, combo.name, combo.kind, stringifyJson(combo.models), combo.isActive ? 1 : 0, combo.groupName, combo.sortOrder, stringifyJson(combo.capabilities), stringifyJson(combo.accessTags), combo.createdAt, combo.updatedAt]
  );
  deleteHotJson(COMBOS_CACHE_KEY).catch(() => {});
  deleteHotJson(comboCacheKey(combo.name)).catch(() => {});
  return combo;
}

export async function updateCombo(id, data) {
  const db = await getAdapter();
  let result = null;
  db.transaction(() => {
    const row = db.get(`SELECT * FROM combos WHERE id = ?`, [id]);
    if (!row) return;
    const merged = { ...rowToCombo(row), ...data, updatedAt: new Date().toISOString() };
    db.run(
      `UPDATE combos SET name = ?, kind = ?, models = ?, isActive = ?, groupName = ?, sortOrder = ?, capabilities = ?, accessTags = ?, updatedAt = ? WHERE id = ?`,
      [merged.name, merged.kind, stringifyJson(merged.models || []), merged.isActive !== false ? 1 : 0, merged.groupName || null, Number.isFinite(merged.sortOrder) ? merged.sortOrder : 0, stringifyJson(merged.capabilities || {}), stringifyJson(merged.accessTags || []), merged.updatedAt, id]
    );
    result = merged;
  });
  if (result) {
    deleteHotJson(COMBOS_CACHE_KEY).catch(() => {});
    deleteHotJson(comboCacheKey(result.name)).catch(() => {});
  }
  return result;
}

export async function deleteCombo(id) {
  const db = await getAdapter();
  const res = db.run(`DELETE FROM combos WHERE id = ?`, [id]);
  if ((res?.changes ?? 0) > 0) deleteHotJson(COMBOS_CACHE_KEY).catch(() => {});
  return (res?.changes ?? 0) > 0;
}
