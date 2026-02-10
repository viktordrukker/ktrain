CREATE TABLE IF NOT EXISTS crash_events (
  id BIGSERIAL PRIMARY KEY,
  occurredAt TEXT NOT NULL,
  appVersion TEXT,
  appBuild TEXT,
  appCommit TEXT,
  appMode TEXT,
  crashType TEXT NOT NULL,
  startupPhase TEXT,
  errorName TEXT,
  errorMessage TEXT,
  stackTrace TEXT,
  hostname TEXT,
  uptimeSeconds DOUBLE PRECISION,
  metadataJson TEXT,
  acknowledgedAt TEXT,
  acknowledgedBy TEXT,
  resolved INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_crash_events_occurred ON crash_events (occurredAt DESC);
CREATE INDEX IF NOT EXISTS idx_crash_events_resolved ON crash_events (resolved, occurredAt DESC);
