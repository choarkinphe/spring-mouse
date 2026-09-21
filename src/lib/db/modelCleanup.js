import { getAdapter } from "./driver.js";
import { parseJson } from "./helpers/jsonCol.js";
import { deleteHotJson } from "@/lib/redis/hotCache.js";
import { resolveProviderAliases } from "@/shared/utils/providerCustomModels";

// Model rows are keyed by a channel's alias, but nothing cascaded them when the
// channel was deleted: removing a provider connection or node left its
// `customModels`, `modelAliases` and `disabledModels` rows behind. Those orphans
// then inflate /api/models (production reached 890KB / 1918 entries, ~1550 of
// them from deleted channels) and leak stale ids into every picker.
//
// `purgeChannelModelRows` handles one channel at delete time; `purgeOrphanedModelRows`
// reconciles rows whose channel is already gone (startup + manual repair).

// The kv scopes that belong to a channel and must be swept with it. `pricing`
// and `mitmAlias` are deliberately excluded: they are global/user config, not
// per-channel model state.
const CHANNEL_SCOPES = ["customModels", "modelAliases", "disabledModels"];

function likePrefix(alias, sep) {
  // Escape LIKE metacharacters so an alias containing _ or % cannot widen the match.
  const escaped = String(alias).replace(/([\\%_])/g, "\\$1");
  return `${escaped}${sep}%`;
}

// modelAliases rows store the value JSON-encoded (e.g. `"cx/gpt-5.6"` including
// the quotes), so a prefix match must run against the encoded form.
function likeJsonPrefix(alias, sep) {
  const escaped = String(alias).replace(/([\\%_])/g, "\\$1");
  return `"${escaped}${sep}%`;
}

// Decode a stored modelAliases value back to its plain "alias/model" string.
function aliasValueText(raw) {
  if (typeof raw !== "string") return "";
  const parsed = parseJson(raw, raw);
  return typeof parsed === "string" ? parsed : "";
}

function aliasSetForChannel(providerId, connection = {}) {
  return resolveProviderAliases(providerId, {
    provider: connection.provider,
    // Connections carry the display prefix nested under providerSpecificData;
    // provider nodes expose it at the top level.
    prefix: connection.providerSpecificData?.prefix ?? connection.prefix,
  });
}

/**
 * Delete every model row belonging to the given channel aliases.
 * Returns how many rows each scope dropped. Runs in one transaction.
 */
export async function purgeChannelModelRows(aliases) {
  const list = [...new Set((aliases || []).filter(Boolean))];
  if (list.length === 0) return { customModels: 0, modelAliases: 0, disabledModels: 0 };

  const db = await getAdapter();
  const removed = { customModels: 0, modelAliases: 0, disabledModels: 0 };

  db.transaction(() => {
    for (const alias of list) {
      // customModels key = `${alias}|${id}|${type}`
      const custom = db.run(
        `DELETE FROM kv WHERE scope = 'customModels' AND key LIKE ? ESCAPE '\\'`,
        [likePrefix(alias, "|")],
      );
      removed.customModels += Number(custom?.changes || 0);

      // modelAliases value = JSON-encoded `${alias}/${id}` (key is the user alias name)
      const aliasRows = db.run(
        `DELETE FROM kv WHERE scope = 'modelAliases' AND value LIKE ? ESCAPE '\\'`,
        [likeJsonPrefix(alias, "/")],
      );
      removed.modelAliases += Number(aliasRows?.changes || 0);

      // disabledModels key = providerAlias
      const disabled = db.run(
        `DELETE FROM kv WHERE scope = 'disabledModels' AND key = ?`,
        [alias],
      );
      removed.disabledModels += Number(disabled?.changes || 0);
    }
  });

  db.flush?.();
  for (const scope of CHANNEL_SCOPES) {
    if (removed[scope] > 0) await deleteHotJson(`kv:${scope}`).catch(() => {});
  }
  return removed;
}

/**
 * Delete the model rows of a single channel identified by its provider id
 * (a connection's `provider`, or a provider node id). This is the cascade hook
 * called from the delete routes.
 */
export async function purgeChannelModelRowsByProviderId(providerId, connection = {}) {
  return purgeChannelModelRows(aliasSetForChannel(providerId, connection));
}

/**
 * Sweep every model row whose owning channel no longer exists.
 *
 * A row is live when its providerAlias (or providerId) resolves to an existing
 * connection or provider node — disabled connections count, because the channel
 * still exists in the dashboard. `dryRun` returns the counts without deleting.
 */
export async function purgeOrphanedModelRows({ dryRun = false } = {}) {
  const db = await getAdapter();

  // Union of every alias form for every channel that still exists.
  const liveAliases = new Set();
  for (const row of db.all(`SELECT provider, data FROM providerConnections`)) {
    const data = parseJson(row.data, {});
    for (const alias of aliasSetForChannel(row.provider, { provider: row.provider, providerSpecificData: data })) {
      liveAliases.add(alias);
    }
  }
  for (const row of db.all(`SELECT id, data FROM providerNodes`)) {
    const data = parseJson(row.data, {});
    for (const alias of aliasSetForChannel(row.id, { provider: row.id, prefix: data.prefix })) {
      liveAliases.add(alias);
    }
  }

  // Safety net: with no channels at all, every row looks orphaned. That state is
  // reachable transiently (a fresh install, a half-applied import), and acting on
  // it would wipe the user's model config. Refuse instead — the caller keeps its
  // rows and a later run (with channels present) sweeps only the real orphans.
  if (liveAliases.size === 0) {
    return { customModels: 0, modelAliases: 0, disabledModels: 0, deleted: false, skipped: "no channels" };
  }

  const orphanKeys = { customModels: [], modelAliases: [], disabledModels: [] };

  for (const row of db.all(`SELECT key, value FROM kv WHERE scope = 'customModels'`)) {
    const value = parseJson(row.value, {}) || {};
    const owned = [value.providerAlias, value.providerId].some((a) => a && liveAliases.has(a));
    if (!owned) orphanKeys.customModels.push(row.key);
  }
  for (const row of db.all(`SELECT key, value FROM kv WHERE scope = 'modelAliases'`)) {
    const alias = aliasValueText(row.value).split("/")[0];
    if (!alias || !liveAliases.has(alias)) orphanKeys.modelAliases.push(row.key);
  }
  for (const row of db.all(`SELECT key FROM kv WHERE scope = 'disabledModels'`)) {
    if (!liveAliases.has(row.key)) orphanKeys.disabledModels.push(row.key);
  }

  const counts = {
    customModels: orphanKeys.customModels.length,
    modelAliases: orphanKeys.modelAliases.length,
    disabledModels: orphanKeys.disabledModels.length,
  };
  if (dryRun) return { ...counts, deleted: false };

  db.transaction(() => {
    for (const scope of CHANNEL_SCOPES) {
      for (const key of orphanKeys[scope]) {
        db.run(`DELETE FROM kv WHERE scope = ? AND key = ?`, [scope, key]);
      }
    }
  });
  db.flush?.();
  for (const scope of CHANNEL_SCOPES) {
    if (counts[scope] > 0) await deleteHotJson(`kv:${scope}`).catch(() => {});
  }

  return { ...counts, deleted: true };
}
