import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";
import { getProviderConnectionById } from "./connectionsRepo.js";

const SCOPE = "codebuddyCheckin";

function read(db, key) {
  const row = db.get("SELECT value FROM kv WHERE scope = ? AND key = ?", [SCOPE, key]);
  if (!row) return {};
  const value = parseJson(row.value, null);
  // Corrupt daily markers must never be treated as a fresh account.
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid check-in state");
  return value;
}

function write(db, key, value) {
  db.run("INSERT INTO kv(scope, key, value) VALUES(?, ?, ?) ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value", [SCOPE, key, stringifyJson(value)]);
}

async function accountKey(connectionId) {
  const connection = await getProviderConnectionById(connectionId);
  const uid = connection?.providerSpecificData?.codebuddyUid;
  return uid ? `account:${connection.provider}:${uid}` : `connection:${connectionId}`;
}

function combined(db, connectionId, key) {
  return { ...read(db, key), enabled: read(db, connectionId).enabled === true };
}

// The switch belongs to a connection, but leases and daily markers belong to
// the upstream UID. Reauthorizing the same account cannot claim in parallel.
export async function getCheckinState(connectionId) {
  const key = await accountKey(connectionId);
  return combined(await getAdapter(), connectionId, key);
}

export async function updateCheckinState(connectionId, updater) {
  const key = await accountKey(connectionId);
  const db = await getAdapter();
  let result;
  db.transaction(() => {
    const current = combined(db, connectionId, key);
    const patch = updater(current);
    result = patch ? { ...current, ...patch } : current;
    if (patch) {
      if (Object.hasOwn(patch, "enabled")) write(db, connectionId, { enabled: patch.enabled === true });
      const { enabled: _enabled, ...accountPatch } = patch;
      if (Object.keys(accountPatch).length) {
        const { enabled: _oldEnabled, ...accountState } = result;
        write(db, key, accountState);
      }
    }
  });
  // sql.js queues disk writes; the lease must reach disk before any claim.
  db.flush?.();
  return result;
}
