CREATE TABLE IF NOT EXISTS schema_migrations (
  id TEXT PRIMARY KEY,
  appliedAt TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id BIGSERIAL PRIMARY KEY,
  externalSubject TEXT NOT NULL UNIQUE,
  email TEXT UNIQUE,
  displayName TEXT,
  role TEXT NOT NULL DEFAULT 'USER',
  isActive INTEGER NOT NULL DEFAULT 1,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  lastLoginAt TEXT
);

CREATE TABLE IF NOT EXISTS user_secrets (
  id BIGSERIAL PRIMARY KEY,
  userId BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  secretKey TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  iv TEXT NOT NULL,
  authTag TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  UNIQUE(userId, secretKey)
);

CREATE TABLE IF NOT EXISTS app_config (
  id BIGSERIAL PRIMARY KEY,
  key TEXT NOT NULL,
  scope TEXT NOT NULL,
  scopeId TEXT NOT NULL,
  valueJson TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  updatedBy TEXT,
  UNIQUE(key, scope, scopeId)
);

CREATE TABLE IF NOT EXISTS audit_log (
  id BIGSERIAL PRIMARY KEY,
  actorUserId BIGINT REFERENCES users(id) ON DELETE SET NULL,
  actorRole TEXT,
  action TEXT NOT NULL,
  targetType TEXT,
  targetId TEXT,
  metadata TEXT,
  requestId TEXT,
  ip TEXT,
  createdAt TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_leaderboard_sort ON leaderboard (contestType, level, contentMode, score DESC, accuracy DESC);
CREATE INDEX IF NOT EXISTS idx_vocab_packs_packtype_active ON vocab_packs (packType, active);
CREATE INDEX IF NOT EXISTS idx_users_role ON users (role);
CREATE INDEX IF NOT EXISTS idx_app_config_scope ON app_config (scope, scopeId);
CREATE INDEX IF NOT EXISTS idx_audit_log_created ON audit_log (createdAt DESC);
