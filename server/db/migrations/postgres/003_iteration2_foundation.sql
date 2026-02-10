ALTER TABLE leaderboard ADD COLUMN IF NOT EXISTS userId BIGINT;
ALTER TABLE leaderboard ADD COLUMN IF NOT EXISTS isGuest INTEGER NOT NULL DEFAULT 1;
ALTER TABLE leaderboard ADD COLUMN IF NOT EXISTS language TEXT NOT NULL DEFAULT 'en';
ALTER TABLE leaderboard ADD COLUMN IF NOT EXISTS displayName TEXT;
ALTER TABLE leaderboard ADD COLUMN IF NOT EXISTS avatarUrl TEXT;

CREATE TABLE IF NOT EXISTS auth_magic_links (
  id BIGSERIAL PRIMARY KEY,
  email TEXT NOT NULL,
  tokenHash TEXT NOT NULL UNIQUE,
  expiresAt TEXT NOT NULL,
  usedAt TEXT,
  createdAt TEXT NOT NULL,
  requestedIp TEXT
);

CREATE TABLE IF NOT EXISTS auth_sessions (
  id BIGSERIAL PRIMARY KEY,
  userId BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tokenHash TEXT NOT NULL UNIQUE,
  createdAt TEXT NOT NULL,
  expiresAt TEXT NOT NULL,
  lastSeenAt TEXT NOT NULL,
  userAgent TEXT,
  ip TEXT,
  revokedAt TEXT
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
  id BIGSERIAL PRIMARY KEY,
  language TEXT NOT NULL,
  type TEXT NOT NULL,
  topic TEXT,
  status TEXT NOT NULL DEFAULT 'DRAFT',
  createdBy BIGINT REFERENCES users(id) ON DELETE SET NULL,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS pack_items (
  id BIGSERIAL PRIMARY KEY,
  packId BIGINT NOT NULL REFERENCES packs(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  difficulty INTEGER,
  metadataJson TEXT
);

CREATE TABLE IF NOT EXISTS active_sessions (
  sessionId TEXT PRIMARY KEY,
  userId BIGINT REFERENCES users(id) ON DELETE SET NULL,
  startedAt TEXT NOT NULL,
  lastSeenAt TEXT NOT NULL,
  mode TEXT NOT NULL,
  isAuthorized INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_auth_magic_links_email ON auth_magic_links (email, createdAt DESC);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_user ON auth_sessions (userId, expiresAt DESC);
CREATE INDEX IF NOT EXISTS idx_packs_lookup ON packs (language, type, status);
CREATE INDEX IF NOT EXISTS idx_pack_items_pack ON pack_items (packId);
CREATE INDEX IF NOT EXISTS idx_active_sessions_seen ON active_sessions (lastSeenAt DESC);
CREATE INDEX IF NOT EXISTS idx_leaderboard_user ON leaderboard (userId, score DESC);
