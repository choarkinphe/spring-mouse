const migration = {
  version: 16,
  name: "mouse-client-ids-and-access-tokens",
  up(db) {
    const mouseColumns = new Set(db.all("PRAGMA table_info(mouses)").map((row) => row.name));
    if (!mouseColumns.has("clientId")) {
      db.exec("ALTER TABLE mouses ADD COLUMN clientId TEXT");
    }
    db.exec("UPDATE mouses SET clientId = 'legacy-' || id WHERE clientId IS NULL OR clientId = ''");
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_mouse_client_id ON mouses(clientId)");

    db.exec(`
      CREATE TABLE IF NOT EXISTS mouseAccessTokens (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        tokenPrefix TEXT NOT NULL,
        tokenHash TEXT UNIQUE NOT NULL,
        expiresAt TEXT,
        createdAt TEXT NOT NULL,
        rotatedAt TEXT,
        revokedAt TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_mouse_access_token_expires ON mouseAccessTokens(expiresAt);
      CREATE INDEX IF NOT EXISTS idx_mouse_access_token_active ON mouseAccessTokens(revokedAt);
    `);
  },
};

export default migration;
