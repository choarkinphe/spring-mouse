import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "./jsonCol.js";
import { deleteHotJson, getHotJson, setHotJson } from "@/lib/redis/hotCache.js";

export function makeKv(scope) {
  const cacheKey = `kv:${scope}`;
  return {
    async get(key, fallback = null) {
      const cached = await getHotJson(cacheKey);
      if (cached && Object.prototype.hasOwnProperty.call(cached, key)) return cached[key];
      const db = await getAdapter();
      const row = db.get(`SELECT value FROM kv WHERE scope = ? AND key = ?`, [scope, key]);
      return row ? parseJson(row.value, fallback) : fallback;
    },
    async getAll() {
      const cached = await getHotJson(cacheKey);
      if (cached && typeof cached === "object" && !Array.isArray(cached)) return cached;
      const db = await getAdapter();
      const rows = db.all(`SELECT key, value FROM kv WHERE scope = ?`, [scope]);
      const out = {};
      for (const r of rows) out[r.key] = parseJson(r.value);
      setHotJson(cacheKey, out, 120).catch(() => {});
      return out;
    },
    async set(key, value) {
      const db = await getAdapter();
      db.run(`INSERT INTO kv(scope, key, value) VALUES(?, ?, ?) ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value`, [scope, key, stringifyJson(value)]);
      const cached = await getHotJson(cacheKey);
      if (cached && typeof cached === "object" && !Array.isArray(cached)) { cached[key] = value; await setHotJson(cacheKey, cached, 120); }
      else await deleteHotJson(cacheKey);
    },
    async setMany(obj) {
      const db = await getAdapter();
      db.transaction(() => {
        for (const [k, v] of Object.entries(obj)) {
          db.run(`INSERT INTO kv(scope, key, value) VALUES(?, ?, ?) ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value`, [scope, k, stringifyJson(v)]);
        }
      });
      await deleteHotJson(cacheKey);
    },
    async remove(key) {
      const db = await getAdapter();
      db.run(`DELETE FROM kv WHERE scope = ? AND key = ?`, [scope, key]);
      const cached = await getHotJson(cacheKey);
      if (cached && typeof cached === "object" && !Array.isArray(cached)) { delete cached[key]; await setHotJson(cacheKey, cached, 120); }
      else await deleteHotJson(cacheKey);
    },
    async clear() {
      const db = await getAdapter();
      db.run(`DELETE FROM kv WHERE scope = ?`, [scope]);
      await deleteHotJson(cacheKey);
    },
  };
}
