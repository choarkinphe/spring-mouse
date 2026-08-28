const migration = {
  version: 12,
  name: "open-platform-call-logs",
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS openPlatformApiCallLogs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        apiKeyId TEXT NOT NULL,
        keyName TEXT NOT NULL,
        keyPrefix TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        method TEXT NOT NULL,
        path TEXT NOT NULL,
        statusCode INTEGER NOT NULL,
        durationMs INTEGER DEFAULT 0,
        sourceIp TEXT,
        userAgent TEXT,
        subjectUserId TEXT
      )
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_opacl_key_ts ON openPlatformApiCallLogs(apiKeyId, timestamp DESC)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_opacl_ts ON openPlatformApiCallLogs(timestamp DESC)`);
  },
};

export default migration;
