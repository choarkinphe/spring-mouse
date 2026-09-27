const migration = {
  version: 24,
  name: "routing-telemetry",
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS routingRequests (
        routingRequestId TEXT PRIMARY KEY,
        modelCallId TEXT,
        trafficRequestId TEXT,
        originalModel TEXT,
        endpoint TEXT,
        role TEXT NOT NULL DEFAULT 'primary',
        requestType TEXT,
        comboName TEXT,
        strategy TEXT,
        autoSource TEXT,
        autoLevel TEXT,
        autoConfidence REAL,
        startedAt TEXT NOT NULL,
        completedAt TEXT,
        outcome TEXT NOT NULL DEFAULT 'unknown',
        terminalReason TEXT,
        attemptCount INTEGER NOT NULL DEFAULT 0,
        meta TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX IF NOT EXISTS idx_rr_started_at ON routingRequests(startedAt DESC);
      CREATE INDEX IF NOT EXISTS idx_rr_outcome_started ON routingRequests(outcome, startedAt DESC);
      CREATE INDEX IF NOT EXISTS idx_rr_original_model_started ON routingRequests(originalModel, startedAt DESC);
      CREATE INDEX IF NOT EXISTS idx_rr_traffic_request ON routingRequests(trafficRequestId);
      CREATE TABLE IF NOT EXISTS routingAttempts (
        attemptId TEXT PRIMARY KEY,
        routingRequestId TEXT NOT NULL,
        modelCallId TEXT,
        role TEXT NOT NULL DEFAULT 'primary',
        provider TEXT,
        model TEXT,
        connectionId TEXT,
        routeIndex INTEGER,
        candidateIndex INTEGER,
        sourceFormat TEXT,
        targetFormat TEXT,
        nativePassthrough INTEGER NOT NULL DEFAULT 0,
        streamMode TEXT,
        startedAt TEXT NOT NULL,
        completedAt TEXT,
        upstreamStatus INTEGER,
        outcome TEXT NOT NULL DEFAULT 'unknown',
        fallbackReason TEXT,
        terminalReason TEXT,
        ttftMs INTEGER,
        durationMs INTEGER,
        promptTokens INTEGER,
        completionTokens INTEGER,
        meta TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX IF NOT EXISTS idx_ra_request_started ON routingAttempts(routingRequestId, startedAt DESC);
      CREATE INDEX IF NOT EXISTS idx_ra_started_at ON routingAttempts(startedAt DESC);
      CREATE INDEX IF NOT EXISTS idx_ra_provider_model_started ON routingAttempts(provider, model, startedAt DESC);
      CREATE INDEX IF NOT EXISTS idx_ra_connection_started ON routingAttempts(connectionId, startedAt DESC);
      CREATE INDEX IF NOT EXISTS idx_ra_role_outcome_started ON routingAttempts(role, outcome, startedAt DESC);
    `);
  },
};

export default migration;
