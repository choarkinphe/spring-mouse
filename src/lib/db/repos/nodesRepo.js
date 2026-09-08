import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";
import { deleteHotJson, getHotJson, setHotJson } from "@/lib/redis/hotCache.js";

function rowToNode(row) {
  if (!row) return null;
  const extra = parseJson(row.data, {});
  return {
    ...extra,
    id: row.id,
    type: row.type,
    name: row.name,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function nodeToRow(n) {
  const { id, type, name, createdAt, updatedAt, ...rest } = n;
  return {
    id,
    type: type ?? null,
    name: name ?? null,
    data: stringifyJson(rest),
    createdAt,
    updatedAt,
  };
}

function upsert(db, n) {
  const r = nodeToRow(n);
  db.run(
    `INSERT INTO providerNodes(id, type, name, data, createdAt, updatedAt)
     VALUES(?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       type=excluded.type, name=excluded.name, data=excluded.data, updatedAt=excluded.updatedAt`,
    [r.id, r.type, r.name, r.data, r.createdAt, r.updatedAt]
  );
}

const PROVIDER_NODES_CACHE_KEY = "provider-nodes";
const PROVIDER_NODES_CACHE_TTL_SECONDS = 120;

export async function getProviderNodes(filter = {}) {
  const cached = await getHotJson(PROVIDER_NODES_CACHE_KEY);
  if (Array.isArray(cached)) return filter.type ? cached.filter((node) => node.type === filter.type) : cached;
  const db = await getAdapter();
  const nodes = db.all(`SELECT * FROM providerNodes`).map(rowToNode);
  setHotJson(PROVIDER_NODES_CACHE_KEY, nodes, PROVIDER_NODES_CACHE_TTL_SECONDS).catch(() => {});
  return filter.type ? nodes.filter((node) => node.type === filter.type) : nodes;
}

export async function getProviderNodeById(id) {
  const db = await getAdapter();
  return rowToNode(db.get(`SELECT * FROM providerNodes WHERE id = ?`, [id]));
}

export async function createProviderNode(data) {
  const db = await getAdapter();
  const now = new Date().toISOString();
  const node = {
    id: data.id || uuidv4(),
    type: data.type,
    name: data.name,
    prefix: data.prefix,
    apiType: data.apiType,
    baseUrl: data.baseUrl,
    icon: data.icon,
    createdAt: now,
    updatedAt: now,
  };
  upsert(db, node);
  deleteHotJson(PROVIDER_NODES_CACHE_KEY).catch(() => {});
  return node;
}

export async function updateProviderNode(id, data) {
  const db = await getAdapter();
  let result = null;
  db.transaction(() => {
    const row = db.get(`SELECT * FROM providerNodes WHERE id = ?`, [id]);
    if (!row) return;
    const merged = { ...rowToNode(row), ...data, updatedAt: new Date().toISOString() };
    upsert(db, merged);
    result = merged;
  });
  if (result) deleteHotJson(PROVIDER_NODES_CACHE_KEY).catch(() => {});
  return result;
}

export async function deleteProviderNode(id) {
  const db = await getAdapter();
  let removed = null;
  db.transaction(() => {
    const row = db.get(`SELECT * FROM providerNodes WHERE id = ?`, [id]);
    if (!row) return;
    removed = rowToNode(row);
    db.run(`DELETE FROM providerNodes WHERE id = ?`, [id]);
  });
  if (removed) deleteHotJson(PROVIDER_NODES_CACHE_KEY).catch(() => {});
  return removed;
}
