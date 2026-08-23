const migration = {
  version: 6,
  name: "api-key-quota-mode",
  up(db) {
    const columns = db.all(`PRAGMA table_info(apiKeys)`).map((row) => row.name);
    if (!columns.includes("quotaMode")) {
      db.exec(`ALTER TABLE apiKeys ADD COLUMN quotaMode TEXT DEFAULT 'unlimited'`);
    }
    // Convert the transient boolean implementation if this database saw it.
    if (columns.includes("quotaEnabled")) {
      db.exec(`UPDATE apiKeys SET quotaMode = CASE WHEN quotaEnabled = 1 THEN 'limited' ELSE 'unlimited' END`);
    }
  },
};

export default migration;
