// Per-key overrides for the global per-model quota groups.
//
// Additive and nullable: an existing key inherits every group's configured
// limits, which is exactly what it did before this column existed. Nothing is
// backfilled, so the migration is safe to re-run and cannot change behaviour on
// its own.
const migration = {
  version: 28,
  name: "api-key-model-quota-overrides",
  up(db) {
    const columns = new Set(db.all(`PRAGMA table_info(apiKeys)`).map((row) => row.name));
    if (!columns.has("modelQuotaOverrides")) {
      db.exec(`ALTER TABLE apiKeys ADD COLUMN modelQuotaOverrides TEXT`);
    }
  },
};

export default migration;
