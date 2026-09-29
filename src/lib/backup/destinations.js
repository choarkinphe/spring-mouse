// Resolves "which backup destination is active" from the settings row.
//
// TWO SHAPES EXIST AT ONCE, ON PURPOSE:
//   - the new `backupDestinations` list (added by migration 025)
//   - the legacy single `backupReplicaUrl` + AccessKey columns
//
// A destination is either a typed record (s3/sftp/webdav/…) whose config lives
// in fields, or a `type:"url"` record that holds the raw litestream URL — the
// shape every pre-existing install is migrated into. Keeping `url` as a real
// type means the migration is lossless (no URL→fields parsing that could drop
// a webdav userinfo or an unknown query) and the engine can keep restoring
// legacy installs down the exact code path they already used.
//
// The legacy columns are ALSO read as a fallback when the list is absent, so
// the engine works even if the migration never ran (a build that predates it,
// or a row the migration refused to touch because its key was lost).

import { getDestinationType, validateDestination } from "@/shared/constants/backupDestinations.js";
import { canDecryptBackupSecret } from "./crypto.js";

const LEGACY_ID = "dst_legacy";

function hasText(value) {
  return String(value ?? "").trim().length > 0;
}

// A stable, collision-resistant id for a newly added destination.
export function newDestinationId() {
  const hex = Array.from({ length: 12 }, () => "0123456789abcdef"[Math.floor(Math.random() * 16)]).join("");
  return `dst_${hex}`;
}

// The list as the rest of the system should see it: the stored array when
// present, otherwise a single synthetic entry describing the legacy URL. The
// synthetic entry is marked `legacy` so callers know its secret still lives in
// the old columns rather than in `secretEncrypted`.
export function resolveBackupSettings(settings = {}) {
  const stored = Array.isArray(settings.backupDestinations) ? settings.backupDestinations : [];
  if (stored.length) {
    return { destinations: stored, legacy: false };
  }
  const url = String(settings.backupReplicaUrl ?? "").trim();
  if (!url) return { destinations: [], legacy: false };
  return {
    legacy: true,
    destinations: [
      {
        id: LEGACY_ID,
        type: "url",
        label: "原有备份目的地",
        config: { url },
        secretEncrypted: null,
        createdAt: null,
        updatedAt: null,
      },
    ],
  };
}

export function getActiveDestinationId(settings = {}, destinations = resolveBackupSettings(settings).destinations) {
  const wanted = settings.backupActiveDestinationId;
  if (wanted && destinations.some((d) => d.id === wanted)) return wanted;
  return destinations[0]?.id ?? null;
}

export function getActiveDestination(settings = {}) {
  const { destinations, legacy } = resolveBackupSettings(settings);
  const id = getActiveDestinationId(settings, destinations);
  return { destination: destinations.find((d) => d.id === id) ?? null, destinations, legacy };
}

// Does this destination have everything it needs to run? `file` and `gs` need
// no credentials at all, so they are always "configured"; sftp is satisfied by
// a key path alone. Otherwise the secret blob must be present AND decryptable —
// `canDecryptBackupSecret` also catches a lost key file, so the UI can say
// "re-enter your credentials" instead of silently failing at the first upload.
//
// The synthetic legacy entry is the one exception: its secret still lives in the
// old `backupAccessKey*Encrypted` columns, so it must be checked against those
// (which is why the settings row is an optional second argument).
export function destinationHasCredentials(destination, settings = null) {
  if (!destination) return false;
  const type = destination.type;
  if (type === "file" || type === "gs") return true;
  if (type === "sftp" && hasText(destination.config?.keyPath)) return true;
  if (!destination.secretEncrypted && destination.id === LEGACY_ID && settings) {
    return canDecryptBackupSecret(settings.backupAccessKeyIdEncrypted)
      && canDecryptBackupSecret(settings.backupAccessKeySecretEncrypted);
  }
  if (!destination.secretEncrypted) return false;
  return canDecryptBackupSecret(destination.secretEncrypted);
}

// Normalize a destination coming in from a request into the stored shape.
// Throws with an operator-readable message on a bad type or missing required
// field — the API turns that into a 400.
export function normalizeDestinationInput({ type, label, config = {}, secret = {} } = {}, { requireSecret = true } = {}) {
  const spec = getDestinationType(type);
  if (!spec) throw new Error(`Unknown backup destination type: ${type}`);
  const cleanConfig = {};
  for (const field of spec.configFields) {
    const raw = config[field.key];
    if (field.type === "boolean") {
      cleanConfig[field.key] = raw === true || raw === "true";
    } else {
      cleanConfig[field.key] = String(raw ?? "").trim();
    }
  }
  const cleanSecret = {};
  for (const field of spec.secretFields) {
    // Secrets are kept VERBATIM — a password may legitimately begin or end with
    // a space, and trimming it would silently corrupt the credential. Only an
    // entirely blank value (after trim) is treated as "not provided".
    const value = String(secret[field.key] ?? "");
    if (value.trim()) cleanSecret[field.key] = value;
  }
  const check = validateDestination({ type, config: cleanConfig, secret: cleanSecret, requireSecret });
  if (!check.ok) {
    throw new Error(Object.values(check.errors)[0] || "Backup destination is incomplete");
  }
  return {
    type,
    label: String(label ?? "").trim() || spec.label,
    config: cleanConfig,
    secret: cleanSecret,
  };
}

export { LEGACY_ID };
