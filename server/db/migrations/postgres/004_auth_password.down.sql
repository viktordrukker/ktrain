DROP INDEX IF EXISTS idx_password_resets_expires;
DROP INDEX IF EXISTS idx_password_resets_user;
DROP INDEX IF EXISTS idx_auth_identities_user;
DROP INDEX IF EXISTS idx_auth_identities_provider_unique;
DROP TABLE IF EXISTS password_resets;
DROP TABLE IF EXISTS auth_identities;
