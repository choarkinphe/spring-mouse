// Convert the legacy single backup config into the destinations list.
//
// BEFORE: `backupReplicaUrl` (one litestream URL) + `backupAccessKeyIdEncrypted`
// / `backupAccessKeySecretEncrypted` (one AccessKey pair).
// AFTER:  `backupDestinations` (a list) + `backupActiveDestinationId`.
//
// The migrated destination keeps `type:"url"` and the ORIGINAL url string. That
// is deliberate: parsing a URL into fields is lossy (a webdavs:// URL can carry
// userinfo; an unknown scheme has no field form), and the engine already knows
// how to replicate and restore a `type:"url"` destination exactly as before.
// So this migration changes the SHAPE of the settings row without changing any
// behaviour an existing install depends on.
//
// If the stored credentials cannot be decrypted (the encryption key file was
// lost), the row is left UNTOUCHED and the legacy columns stay readable — the
// runtime falls back to them, so the operator sees "re-enter your credentials"
// rather than a backup that silently stopped.

import { encryptBackupSecret, decryptBackupSecret } from "../../backup/crypto.js";

const migration = {
  version: 25,
  name: "backup-destinations",
  up(db) {
    const row = db.get(`SELECT data FROM settings WHERE id = 1`);
    if (!row) return;

    let settings;
    try {
      settings = JSON.parse(row.data || "{}");
    } catch {
      return; // Preserve a malformed row rather than risk destroying it.
    }

    // Already migrated (or a fresh install that already used the new shape).
    if (Array.isArray(settings.backupDestinations) && settings.backupDestinations.length) return;

    const url = String(settings.backupReplicaUrl ?? "").trim();
    if (!url) return; // Nothing to migrate.

    const idEncrypted = settings.backupAccessKeyIdEncrypted ?? null;
    const secretEncrypted = settings.backupAccessKeySecretEncrypted ?? null;

    let newSecretEncrypted = null;
    if (idEncrypted || secretEncrypted) {
      try {
        const accessKeyId = idEncrypted ? decryptBackupSecret(idEncrypted) : "";
        const accessKeySecret = secretEncrypted ? decryptBackupSecret(secretEncrypted) : "";
        newSecretEncrypted = encryptBackupSecret(JSON.stringify({ accessKeyId, accessKeySecret }));
      } catch {
        // Key lost/rotated: leave the legacy columns in place so the runtime
        // fallback still resolves them and the UI can ask for a re-entry.
        return;
      }
    }

    const now = new Date().toISOString();
    settings.backupDestinations = [
      {
        id: "dst_legacy",
        type: "url",
        label: "原有备份目的地",
        config: { url },
        secretEncrypted: newSecretEncrypted,
        createdAt: now,
        updatedAt: now,
      },
    ];
    settings.backupActiveDestinationId = "dst_legacy";
    delete settings.backupReplicaUrl;
    delete settings.backupAccessKeyIdEncrypted;
    delete settings.backupAccessKeySecretEncrypted;

    db.run(`UPDATE settings SET data = ? WHERE id = 1`, [JSON.stringify(settings)]);
  },
};

export default migration;
