CREATE TABLE IF NOT EXISTS schema_migrations (
  id TEXT PRIMARY KEY,
  appliedAt TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
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
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  userId INTEGER NOT NULL,
  secretKey TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  iv TEXT NOT NULL,
  authTag TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  UNIQUE(userId, secretKey),
  FOREIGN KEY(userId) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS app_config (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL,
  scope TEXT NOT NULL,
  scopeId TEXT NOT NULL,
  valueJson TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  updatedBy TEXT,
  UNIQUE(key, scope, scopeId)
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actorUserId INTEGER,
  actorRole TEXT,
  action TEXT NOT NULL,
  targetType TEXT,
  targetId TEXT,
  metadata TEXT,
  requestId TEXT,
  ip TEXT,
  createdAt TEXT NOT NULL,
  FOREIGN KEY(actorUserId) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_leaderboard_sort ON leaderboard (contestType, level, contentMode, score DESC, accuracy DESC);
CREATE INDEX IF NOT EXISTS idx_vocab_packs_packtype_active ON vocab_packs (packType, active);
CREATE INDEX IF NOT EXISTS idx_users_role ON users (role);
CREATE INDEX IF NOT EXISTS idx_app_config_scope ON app_config (scope, scopeId);
CREATE INDEX IF NOT EXISTS idx_audit_log_created ON audit_log (createdAt DESC);
