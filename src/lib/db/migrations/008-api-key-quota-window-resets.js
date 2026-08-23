const FIELDS = {
  fiveHour: "fiveHourQuotaResetAt",
  weekly: "weeklyQuotaResetAt",
};

const migration = {
  version: 8,
  name: "api-key-quota-window-resets",
  up(db) {
    const columns = new Set(db.all(`PRAGMA table_info(apiKeys)`).map((row) => row.name));

    for (const field of Object.values(FIELDS)) {
      if (!columns.has(field)) {
        db.exec(`ALTER TABLE apiKeys ADD COLUMN ${field} TEXT`);
      }
    }

    // The previous reset action reset both windows. Preserve that exact
    // behavior for databases that already used it.
    db.exec(`
      UPDATE apiKeys
         SET fiveHourQuotaResetAt = COALESCE(fiveHourQuotaResetAt, quotaResetAt),
             weeklyQuotaResetAt = COALESCE(weeklyQuotaResetAt, quotaResetAt)
    `);

    // quotaMode "off" replaced the removed enable/disable toggle. Sync old
    // rows so dashboard state and authentication agree.
    db.exec(`UPDATE apiKeys SET isActive = 0 WHERE quotaMode = 'off'`);
  },
};

export default migration;
