const migration = {
  version: 7,
  name: "api-key-quota-reset",
  up(db) {
    const columns = db.all(`PRAGMA table_info(apiKeys)`).map((row) => row.name);
    if (!columns.includes("quotaResetAt")) {
      db.exec(`ALTER TABLE apiKeys ADD COLUMN quotaResetAt TEXT`);
    }
  },
};

export default migration;
