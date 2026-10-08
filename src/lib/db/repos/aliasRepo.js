import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";
import { makeKv } from "../helpers/kvStore.js";
import { deleteHotJson } from "@/lib/redis/hotCache.js";

const aliasKv = makeKv("modelAliases");
const customKv = makeKv("customModels");
const mitmKv = makeKv("mitmAlias");

// modelAliases: key=alias, value=modelString
export async function getModelAliases() {
  return await aliasKv.getAll();
}

export async function setModelAlias(alias, model) {
  await aliasKv.set(alias, model);
}

export async function deleteModelAlias(alias) {
  await aliasKv.remove(alias);
}

// customModels: key=`${providerAlias}|${id}|${type}`, value=full model object
function customKey(providerAlias, id, type) {
  return `${providerAlias}|${id}|${type}`;
}

export async function getCustomModels() {
  const all = await customKv.getAll();
  return Object.values(all);
}

// Atomic check-then-insert inside transaction to prevent duplicate races
export async function addCustomModel({ providerAlias, id, type = "llm", name }) {
  const k = customKey(providerAlias, id, type);
  const db = await getAdapter();
  let added = false;
  db.transaction(() => {
    const row = db.get(`SELECT 1 FROM kv WHERE scope = 'customModels' AND key = ?`, [k]);
    if (row) return;
    const value = stringifyJson({ providerAlias, id, type, name: name || id });
    db.run(`INSERT INTO kv(scope, key, value) VALUES('customModels', ?, ?)`, [k, value]);
    added = true;
  });
  db.flush?.();
  if (added) await deleteHotJson("kv:customModels").catch(() => {});
  return added;
}

export async function syncCustomModels(models, { replaceSyncedFor } = {}) {
  const db = await getAdapter();
  let added = 0;
  let updated = 0;
  let unchanged = 0;
  let removed = 0;
  const syncedSources = new Set(["official", "catalog", "models-dev", "static"]);

  db.transaction(() => {
    if (replaceSyncedFor) {
      const incoming = new Set((models || []).map((model) => customKey(model.providerAlias, model.id, model.type || "llm")));
      for (const row of db.all(`SELECT key, value FROM kv WHERE scope = 'customModels'`)) {
        const existing = parseJson(row.value);
        if (existing?.providerAlias !== replaceSyncedFor || !syncedSources.has(existing.source) || incoming.has(row.key)) continue;
        db.run(`DELETE FROM kv WHERE scope = 'customModels' AND key = ?`, [row.key]);
        removed += 1;
      }
    }
    for (const model of models || []) {
      const type = model.type || "llm";
      const k = customKey(model.providerAlias, model.id, type);
      const value = {
        ...model,
        type,
        name: model.name || model.id,
      };
      const row = db.get(`SELECT value FROM kv WHERE scope = 'customModels' AND key = ?`, [k]);
      if (replaceSyncedFor && row) {
        const existing = parseJson(row.value);
        // A manual row remains manual even when the endpoint also lists its id.
        // Otherwise a later sync could delete a model the user explicitly added.
        if (existing && !syncedSources.has(existing.source)) {
          unchanged += 1;
          continue;
        }
      }
      const serialized = stringifyJson(value);
      if (!row) {
        db.run(`INSERT INTO kv(scope, key, value) VALUES('customModels', ?, ?)`, [k, serialized]);
        added += 1;
      } else if (row.value !== serialized) {
        db.run(`UPDATE kv SET value = ? WHERE scope = 'customModels' AND key = ?`, [serialized, k]);
        updated += 1;
      } else {
        unchanged += 1;
      }
    }
  });
  db.flush?.();
  if (added > 0 || updated > 0 || removed > 0) await deleteHotJson("kv:customModels").catch(() => {});

  return { added, updated, unchanged, ...(replaceSyncedFor ? { removed } : {}) };
}

export async function deleteCustomModel({ providerAlias, id, type = "llm" }) {
  const db = await getAdapter();
  db.run(`DELETE FROM kv WHERE scope = 'customModels' AND key = ?`, [customKey(providerAlias, id, type)]);
  db.flush?.();
  await deleteHotJson("kv:customModels").catch(() => {});
}

// Marks rows that exist purely to carry capability metadata for a model that is
// otherwise defined by the static registry. They are deleted once the last
// capability flag is cleared so the built-in pattern table applies again.
export const CAPABILITY_OVERRIDE_ORIGIN = "capability-override";

/**
 * Upsert per-model capability metadata for any model (built-in or custom).
 * Built-in models get a capability-only row on demand; the runtime override
 * pipeline (src/lib/modelCapabilityOverrides.js) picks it up automatically.
 */
export async function upsertModelCapabilities({ providerAlias, providerId, id, type = "llm", capabilities }) {
  if (!providerAlias || !id) return { changed: false, removed: false, capabilities: {} };

  const clean = {};
  for (const [key, value] of Object.entries(capabilities || {})) {
    if (typeof value === "boolean") clean[key] = value;
    if ((key === "contextWindow" || key === "maxOutput") && Number.isFinite(value) && value > 0) {
      clean[key] = value;
    }
  }
  const hasCapabilities = Object.keys(clean).length > 0;

  const k = customKey(providerAlias, id, type);
  const db = await getAdapter();
  let changed = false;
  let removed = false;

  db.transaction(() => {
    const row = db.get(`SELECT value FROM kv WHERE scope = 'customModels' AND key = ?`, [k]);

    if (!row) {
      if (!hasCapabilities) return;
      const value = stringifyJson({
        providerAlias,
        ...(providerId ? { providerId } : {}),
        id,
        type,
        name: id,
        origin: CAPABILITY_OVERRIDE_ORIGIN,
        capabilities: clean,
      });
      db.run(`INSERT INTO kv(scope, key, value) VALUES('customModels', ?, ?)`, [k, value]);
      changed = true;
      return;
    }

    const existing = parseJson(row.value) || {};

    // Cleared back to "no metadata" — drop capability-only rows entirely.
    if (!hasCapabilities && existing.origin === CAPABILITY_OVERRIDE_ORIGIN) {
      db.run(`DELETE FROM kv WHERE scope = 'customModels' AND key = ?`, [k]);
      changed = true;
      removed = true;
      return;
    }

    const next = { ...existing };
    if (hasCapabilities) next.capabilities = clean;
    else delete next.capabilities;
    if (providerId && !next.providerId) next.providerId = providerId;

    const serialized = stringifyJson(next);
    if (serialized === row.value) return;
    db.run(`UPDATE kv SET value = ? WHERE scope = 'customModels' AND key = ?`, [serialized, k]);
    changed = true;
  });

  db.flush?.();
  if (changed) await deleteHotJson("kv:customModels").catch(() => {});

  return { changed, removed, capabilities: hasCapabilities ? clean : {} };
}

// mitmAlias: key=toolName, value=mappings object
export async function getMitmAlias(toolName) {
  if (toolName) {
    const v = await mitmKv.get(toolName);
    return v || {};
  }
  return await mitmKv.getAll();
}

export async function setMitmAliasAll(toolName, mappings) {
  await mitmKv.set(toolName, mappings || {});
}
