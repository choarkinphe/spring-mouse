const migration = {
  version: 14,
  name: "mouses",
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS mouses (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        accessTokenHash TEXT UNIQUE NOT NULL,
        version TEXT,
        capabilities TEXT NOT NULL DEFAULT '[]',
        metadata TEXT NOT NULL DEFAULT '{}',
        registrationIp TEXT,
        lastHeartbeatAt TEXT,
        registeredAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        disabledAt TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_mouse_heartbeat ON mouses(lastHeartbeatAt);
      CREATE INDEX IF NOT EXISTS idx_mouse_disabled ON mouses(disabledAt);

      CREATE TABLE IF NOT EXISTS mouseRegistrationTokens (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        tokenPrefix TEXT NOT NULL,
        tokenHash TEXT UNIQUE NOT NULL,
        expiresAt TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        usedAt TEXT,
        usedByMouseId TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_mouse_token_expires ON mouseRegistrationTokens(expiresAt);
      CREATE INDEX IF NOT EXISTS idx_mouse_token_used ON mouseRegistrationTokens(usedAt);
    `);

    const columns = new Set(db.all("PRAGMA table_info(providerConnections)").map((row) => row.name));
    if (!columns.has("mouseId")) {
      db.exec("ALTER TABLE providerConnections ADD COLUMN mouseId TEXT");
    }
    db.exec("CREATE INDEX IF NOT EXISTS idx_pc_mouse ON providerConnections(mouseId)");
  },
};

export default migration;
