ALTER TABLE leaderboard ADD COLUMN userId INTEGER;
ALTER TABLE leaderboard ADD COLUMN isGuest INTEGER NOT NULL DEFAULT 1;
ALTER TABLE leaderboard ADD COLUMN language TEXT NOT NULL DEFAULT 'en';
ALTER TABLE leaderboard ADD COLUMN displayName TEXT;
ALTER TABLE leaderboard ADD COLUMN avatarUrl TEXT;

CREATE TABLE IF NOT EXISTS auth_magic_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL,
  tokenHash TEXT NOT NULL UNIQUE,
  expiresAt TEXT NOT NULL,
  usedAt TEXT,
  createdAt TEXT NOT NULL,
  requestedIp TEXT
);

CREATE TABLE IF NOT EXISTS auth_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  userId INTEGER NOT NULL,
  tokenHash TEXT NOT NULL UNIQUE,
  createdAt TEXT NOT NULL,
  expiresAt TEXT NOT NULL,
  lastSeenAt TEXT NOT NULL,
  userAgent TEXT,
  ip TEXT,
  revokedAt TEXT,
  FOREIGN KEY(userId) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS system_secrets (
  secretKey TEXT PRIMARY KEY,
  ciphertext TEXT NOT NULL,
  iv TEXT NOT NULL,
  authTag TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  updatedBy TEXT
);

CREATE TABLE IF NOT EXISTS packs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  language TEXT NOT NULL,
  type TEXT NOT NULL,
  topic TEXT,
  status TEXT NOT NULL DEFAULT 'DRAFT',
  createdBy INTEGER,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  FOREIGN KEY(createdBy) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS pack_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  packId INTEGER NOT NULL,
  text TEXT NOT NULL,
  difficulty INTEGER,
  metadataJson TEXT,
  FOREIGN KEY(packId) REFERENCES packs(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS active_sessions (
  sessionId TEXT PRIMARY KEY,
  userId INTEGER,
  startedAt TEXT NOT NULL,
  lastSeenAt TEXT NOT NULL,
  mode TEXT NOT NULL,
  isAuthorized INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY(userId) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_auth_magic_links_email ON auth_magic_links (email, createdAt DESC);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_user ON auth_sessions (userId, expiresAt DESC);
CREATE INDEX IF NOT EXISTS idx_packs_lookup ON packs (language, type, status);
CREATE INDEX IF NOT EXISTS idx_pack_items_pack ON pack_items (packId);
CREATE INDEX IF NOT EXISTS idx_active_sessions_seen ON active_sessions (lastSeenAt DESC);
CREATE INDEX IF NOT EXISTS idx_leaderboard_user ON leaderboard (userId, score DESC);
