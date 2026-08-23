const migration = {
  version: 5,
  name: "api-key-quota",
  up(db) {
    const columns = db.all(`PRAGMA table_info(apiKeys)`).map((row) => row.name);
    if (!columns.includes("quotaMode")) {
      db.exec(`ALTER TABLE apiKeys ADD COLUMN quotaMode TEXT DEFAULT 'unlimited'`);
    }
    db.exec(`CREATE INDEX IF NOT EXISTS idx_uh_key_completed ON usageHistory(apiKeyId, completedAt)`);
  },
};

export default migration;
