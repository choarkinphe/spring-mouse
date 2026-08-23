// Make usage records safe to expose and precise enough for request-time reporting.
import { createHmac, randomBytes } from "node:crypto";

function legacyKeyId(key, secret) {
  return key ? `external:${createHmac("sha256", secret).update(key).digest("hex").slice(0, 32)}` : "local-no-key";
}

export default {
  version: 4,
  name: "secure-usage-request-lifecycle",
  up(db) {
    // Versioned migrations run before additive schema sync, so add our columns here too.
    const columns = new Set(db.all(`PRAGMA table_info(usageHistory)`).map((row) => row.name));
    for (const [name, type] of [["apiKeyId", "TEXT"], ["requestId", "TEXT"], ["startedAt", "TEXT"], ["completedAt", "TEXT"]]) {
      if (!columns.has(name)) db.exec(`ALTER TABLE usageHistory ADD COLUMN ${name} ${type}`);
    }

    const storedSecret = db.get(`SELECT value FROM _meta WHERE key = 'usageKeyFingerprintSecret'`)?.value;
    const fingerprintSecret = storedSecret || randomBytes(32).toString("hex");
    if (!storedSecret) db.run(`INSERT INTO _meta(key, value) VALUES('usageKeyFingerprintSecret', ?)`, [fingerprintSecret]);
    const knownKeys = new Map(db.all(`SELECT id, key FROM apiKeys`).map((row) => [row.key, row.id]));
    const rows = db.all(`SELECT id, timestamp, apiKey, apiKeyId, startedAt, completedAt FROM usageHistory`);
    // Old daily JSON blobs include raw key values. They are a cache of history,
    // so discard them rather than retaining credentials; reads now aggregate exact history.
    db.run(`DELETE FROM usageDaily`);

    for (const row of rows) {
      const apiKeyId = row.apiKeyId || knownKeys.get(row.apiKey) || legacyKeyId(row.apiKey, fingerprintSecret);
      db.run(
        `UPDATE usageHistory
           SET apiKeyId = ?,
               startedAt = COALESCE(startedAt, timestamp),
               completedAt = COALESCE(completedAt, timestamp),
               apiKey = NULL
         WHERE id = ?`,
        [apiKeyId, row.id],
      );
    }
  },
};
