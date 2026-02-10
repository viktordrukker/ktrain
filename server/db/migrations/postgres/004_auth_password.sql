ALTER TABLE users ADD COLUMN IF NOT EXISTS avatarUrl TEXT;

CREATE TABLE IF NOT EXISTS auth_identities (
  id BIGSERIAL PRIMARY KEY,
  userId BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  providerSubject TEXT,
  passwordHash TEXT,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  UNIQUE(userId, provider)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_auth_identities_provider_unique
  ON auth_identities (provider, providerSubject)
  WHERE providerSubject IS NOT NULL;

CREATE TABLE IF NOT EXISTS password_resets (
  id BIGSERIAL PRIMARY KEY,
  userId BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tokenHash TEXT NOT NULL UNIQUE,
  expiresAt TEXT NOT NULL,
  usedAt TEXT,
  createdAt TEXT NOT NULL,
  requestedIp TEXT
);

CREATE INDEX IF NOT EXISTS idx_auth_identities_user ON auth_identities (userId, provider);
CREATE INDEX IF NOT EXISTS idx_password_resets_user ON password_resets (userId, createdAt DESC);
CREATE INDEX IF NOT EXISTS idx_password_resets_expires ON password_resets (expiresAt);
