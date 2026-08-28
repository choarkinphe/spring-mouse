const migration = {
  version: 11,
  name: "open-platform-api-keys",
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS openPlatformApiKeys (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        keyPrefix TEXT NOT NULL,
        keyHash TEXT UNIQUE NOT NULL,
        isActive INTEGER DEFAULT 1,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        lastUsedAt TEXT
      )
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_opak_hash ON openPlatformApiKeys(keyHash)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_opak_active ON openPlatformApiKeys(isActive)`);
  },
};

export default migration;
