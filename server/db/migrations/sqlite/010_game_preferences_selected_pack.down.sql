PRAGMA foreign_keys = OFF;
BEGIN TRANSACTION;

CREATE TABLE game_preferences_old (
  userId INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  mode TEXT NOT NULL DEFAULT 'learning',
  level INTEGER NOT NULL DEFAULT 1,
  contentType TEXT NOT NULL DEFAULT 'default',
  language TEXT NOT NULL DEFAULT 'en',
  updatedAt TEXT NOT NULL
);

INSERT INTO game_preferences_old (userId, mode, level, contentType, language, updatedAt)
SELECT userId, mode, level, contentType, language, updatedAt
FROM game_preferences;

DROP TABLE game_preferences;
ALTER TABLE game_preferences_old RENAME TO game_preferences;

COMMIT;
PRAGMA foreign_keys = ON;
