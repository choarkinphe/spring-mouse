// CRUD over the saved backup destinations, shared by the destination API
// routes. Keeps the three things that must always agree in one place:
//
//   1. the stored shape (list + active id inside the settings JSON blob),
//   2. the encrypted secret (one AES blob per destination, never the raw pair),
//   3. the running replicator (litestream allows ONE replica per database, so
//      activating or editing the active destination must replace the child).
//
// ORDER MATTERS: every mutation is applied to the engine FIRST and persisted
// only if the engine accepts it. A destination with bad credentials therefore
// never becomes the stored state — the caller gets the real error and the
// previously working config stays in place. (The settings PATCH used to have the
// opposite order and could leave a 400 response with the row already changed;
// this module deliberately does not repeat that, and `setBackupEnabled` replaced
// the PATCH's backup handling entirely.)
//
// The legacy single-URL config is MATERIALIZED into the list on first mutation
// (see resolveBackupSettings): the synthetic `type:"url"` entry is written to
// `backupDestinations` so appending a new destination cannot silently orphan it.

import { getSettings, updateSettings } from "@/lib/db/repos/settingsRepo.js";
import { encryptBackupSecret, decryptBackupSecret } from "./crypto.js";
import { getDefaultReplicaUrl } from "./litestreamConfig.js";
import {
  resolveBackupSettings,
  getActiveDestinationId,
  destinationHasCredentials,
  normalizeDestinationInput,
  newDestinationId,
  LEGACY_ID,
} from "./destinations.js";
import { describeDestination, getDestinationType, validateDestination } from "@/shared/constants/backupDestinations.js";
import { applyBackupSettings } from "./supervisor.js";

// Thrown when an [id] does not exist, so a route can answer 404 instead of 400.
export class DestinationNotFoundError extends Error {
  constructor() {
    super("Backup destination not found");
    this.name = "DestinationNotFoundError";
  }
}

// Every other failure this module raises is operator-fixable configuration (a
// missing field, credentials litestream rejected), which the routes report as
// 400 so the drawer can show the message next to the field. Only a missing
// destination is a 404.
export function destinationErrorStatus(error) {
  return error instanceof DestinationNotFoundError ? 404 : 400;
}

// The client-facing view of one destination: enough to render a row and pre-fill
// the edit drawer, never the secret. `displayUrl` is derived and secret-free.
export function toPublicDestination(destination, activeId, settings = null) {
  return {
    id: destination.id,
    type: destination.type,
    label: destination.label || getDestinationType(destination.type)?.label || destination.type,
    config: destination.config ?? {},
    displayUrl: describeDestination(destination),
    hasCredentials: destinationHasCredentials(destination, settings),
    isActive: destination.id === activeId,
    updatedAt: destination.updatedAt ?? null,
  };
}

function loadBase(settings) {
  const { destinations } = resolveBackupSettings(settings);
  const activeId = getActiveDestinationId(settings, destinations);
  return { destinations, activeId };
}

export function listPublicDestinations(settings) {
  const { destinations, activeId } = loadBase(settings);
  return destinations.map((d) => toPublicDestination(d, activeId, settings));
}

export async function getDestinationsView() {
  const settings = await getSettings();
  const { destinations, activeId } = loadBase(settings);
  return {
    enabled: settings.backupEnabled === true,
    activeDestinationId: activeId,
    destinations: destinations.map((d) => toPublicDestination(d, activeId, settings)),
  };
}

// Apply a candidate state to the running engine, then persist. A throw from the
// engine propagates and nothing is written.
//
// The legacy single-URL columns are the fallback `resolveBackupSettings`
// synthesizes a destination from when the stored list is EMPTY. That fallback is
// right for an install migration 025 could not convert, but once the list is
// materialized it becomes a resurrection bug: deleting the migrated entry leaves
// `backupReplicaUrl` behind and the fallback brings it straight back.
//
// So the columns are cleared ONLY when the resulting list no longer contains the
// legacy entry — the one case the fallback would misfire on. While the entry is
// still in the list the columns are left alone: they ARE that entry's secret
// store (it has no `secretEncrypted` of its own), and they may hold ciphertext
// this key cannot read, so destroying them would remove the only copy an
// operator could recover by restoring a lost key file.
async function commit(settings, patch) {
  const next = { ...patch };
  const keepsLegacyEntry = (patch.backupDestinations ?? []).some((d) => d.id === LEGACY_ID);
  if (!keepsLegacyEntry) {
    next.backupReplicaUrl = "";
    next.backupAccessKeyIdEncrypted = null;
    next.backupAccessKeySecretEncrypted = null;
  }
  await applyBackupSettings({ ...settings, ...next });
  return updateSettings(next);
}

// Merge a freshly entered secret over the stored one so a partial edit (e.g. a
// rotated secret but an unchanged id) does not drop the untouched field. A
// stored blob that will not decrypt (key lost) is treated as empty rather than
// throwing — the operator is re-entering it anyway.
function mergeSecret(existing, incoming) {
  let previous = {};
  if (existing?.secretEncrypted) {
    try {
      previous = JSON.parse(decryptBackupSecret(existing.secretEncrypted));
    } catch {
      previous = {};
    }
  }
  return { ...previous, ...incoming };
}

function encryptSecretOrNull(secret) {
  return Object.keys(secret).length ? encryptBackupSecret(JSON.stringify(secret)) : null;
}

export async function createDestination(input) {
  const settings = await getSettings();
  const { destinations, activeId } = loadBase(settings);
  const clean = normalizeDestinationInput(input, { requireSecret: true });
  // `url` is a migration artifact, not something an operator creates.
  if (clean.type === "url") throw new Error("Unknown backup destination type: url");

  const now = new Date().toISOString();
  const destination = {
    id: newDestinationId(),
    type: clean.type,
    label: clean.label,
    config: clean.config,
    secretEncrypted: encryptSecretOrNull(clean.secret),
    createdAt: now,
    updatedAt: now,
  };
  const nextList = [...destinations, destination];
  // The first destination added becomes the active one, so "add then save"
  // leaves the install in a working state without a second click.
  const nextActiveId = activeId ?? destination.id;
  const saved = await commit(settings, {
    backupDestinations: nextList,
    backupActiveDestinationId: nextActiveId,
  });
  return { settings: saved, destinationId: destination.id };
}

export async function editDestination(id, patch = {}) {
  const settings = await getSettings();
  const { destinations, activeId } = loadBase(settings);
  const index = destinations.findIndex((d) => d.id === id);
  if (index === -1) throw new DestinationNotFoundError();
  const existing = destinations[index];
  // `type:"url"` is the migrated legacy shape and is READ-ONLY here. Editing it
  // would either have to parse the URL into fields (lossy — a webdavs:// userinfo
  // or an unknown query would be dropped) or write it back through the same
  // legacy code path we are retiring. The operator's move is to add a typed
  // destination and delete this one.
  if (existing.type === "url") {
    throw new Error("旧版 URL 保存位置不可编辑，请新增一个保存位置后删除它");
  }

  // The drawer sends the full config field set for the type, so a plain merge is
  // enough; label falls back to the stored one when omitted.
  const clean = normalizeDestinationInput(
    {
      type: existing.type,
      label: patch.label ?? existing.label,
      config: { ...existing.config, ...(patch.config ?? {}) },
      secret: patch.secret ?? {},
    },
    { requireSecret: false },
  );

  // Blank secret fields mean "keep what is stored", so the RESULT must still
  // satisfy the type's credential requirement — validated against the merged
  // secret, not the incoming one.
  const mergedSecret = mergeSecret(existing, clean.secret);
  const check = validateDestination({ type: existing.type, config: clean.config, secret: mergedSecret, requireSecret: true });
  if (!check.ok) throw new Error(Object.values(check.errors)[0] || "Backup destination is incomplete");

  const updated = {
    ...existing,
    label: clean.label,
    config: clean.config,
    // Only rewrite the blob when something was actually entered, so an edit that
    // touches only the label leaves the stored ciphertext (and its fingerprint)
    // byte-identical.
    secretEncrypted: Object.keys(clean.secret).length ? encryptSecretOrNull(mergedSecret) : existing.secretEncrypted,
    updatedAt: new Date().toISOString(),
  };
  const nextList = destinations.map((d, i) => (i === index ? updated : d));
  const saved = await commit(settings, {
    backupDestinations: nextList,
    backupActiveDestinationId: activeId,
  });
  return { settings: saved, destinationId: id };
}

export async function deleteDestination(id) {
  const settings = await getSettings();
  const { destinations, activeId } = loadBase(settings);
  if (!destinations.some((d) => d.id === id)) throw new DestinationNotFoundError();

  const nextList = destinations.filter((d) => d.id !== id);
  // Deleting the active one hands replication to the next in the list; deleting
  // the LAST one turns backup off rather than leaving a supervisor retrying
  // against a destination that no longer exists.
  const nextActiveId = nextList.some((d) => d.id === activeId) ? activeId : (nextList[0]?.id ?? null);
  const patch = {
    backupDestinations: nextList,
    backupActiveDestinationId: nextActiveId,
  };
  if (nextList.length === 0) patch.backupEnabled = false;
  const saved = await commit(settings, patch);
  return { settings: saved };
}

export async function activateDestination(id) {
  const settings = await getSettings();
  const { destinations } = loadBase(settings);
  if (!destinations.some((d) => d.id === id)) throw new DestinationNotFoundError();
  // Persist the resolved list too, which materializes a legacy entry so the
  // stored list and the active pointer cannot disagree.
  const saved = await commit(settings, {
    backupDestinations: destinations,
    backupActiveDestinationId: id,
  });
  return { settings: saved, destinationId: id };
}

// Turn replication on or off. This is the ONE place the ordering bug of the old
// settings PATCH is fixed: that handler persisted `backupEnabled: true` and only
// THEN started the engine, so a failed start answered 400 while the database was
// already left enabled (the UI rolled back, the row did not). Here the engine is
// started against the CANDIDATE state first, and the row is written only if it
// succeeded — a failed enable changes nothing.
//
// Enabling with no saved destination seeds the local default, so "enable" stays
// a single click; that seed is written in the SAME patch as `backupEnabled`, so
// the stored row never has `enabled: true` with an empty list.
export async function setBackupEnabled(enabled) {
  const settings = await getSettings();
  const { destinations } = loadBase(settings);
  // Disabling is NOT deleting: leave the list and the legacy columns alone so a
  // legacy install is not silently migrated (or its URL dropped) by flipping the
  // switch off. Only the flag changes, and the engine is stopped.
  if (!enabled) {
    await applyBackupSettings({ ...settings, backupEnabled: false });
    return { settings: await updateSettings({ backupEnabled: false }) };
  }

  // Enabling takes ownership of the list: persist the resolved list (so a
  // legacy entry becomes real) and seed a local destination when none exists —
  // both in the SAME patch as `backupEnabled`, so the stored row never has
  // `enabled: true` with an empty list. commit clears the legacy columns when
  // the legacy entry is no longer present.
  let nextList = destinations;
  let nextActiveId = getActiveDestinationId(settings, destinations);
  if (nextList.length === 0) {
    const now = new Date().toISOString();
    const seeded = {
      id: newDestinationId(),
      type: "file",
      label: "本机备份",
      config: { path: getDefaultReplicaUrl().replace(/^file:\/\//, "") },
      secretEncrypted: null,
      createdAt: now,
      updatedAt: now,
    };
    nextList = [seeded];
    nextActiveId = seeded.id;
  }
  const saved = await commit(settings, {
    backupEnabled: true,
    backupDestinations: nextList,
    backupActiveDestinationId: nextActiveId,
  });
  return { settings: saved };
}

