ALTER TABLE users ADD COLUMN avatarUrl TEXT;

CREATE TABLE IF NOT EXISTS auth_identities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  userId INTEGER NOT NULL,
  provider TEXT NOT NULL,
  providerSubject TEXT,
  passwordHash TEXT,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  UNIQUE(provider, providerSubject),
  UNIQUE(userId, provider),
  FOREIGN KEY(userId) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS password_resets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  userId INTEGER NOT NULL,
  tokenHash TEXT NOT NULL UNIQUE,
  expiresAt TEXT NOT NULL,
  usedAt TEXT,
  createdAt TEXT NOT NULL,
  requestedIp TEXT,
  FOREIGN KEY(userId) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_auth_identities_user ON auth_identities (userId, provider);
CREATE INDEX IF NOT EXISTS idx_auth_identities_provider ON auth_identities (provider, providerSubject);
CREATE INDEX IF NOT EXISTS idx_password_resets_user ON password_resets (userId, createdAt DESC);
CREATE INDEX IF NOT EXISTS idx_password_resets_expires ON password_resets (expiresAt);
