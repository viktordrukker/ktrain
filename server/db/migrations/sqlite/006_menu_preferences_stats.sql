CREATE TABLE IF NOT EXISTS game_preferences (
  userId INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  mode TEXT NOT NULL DEFAULT 'learning',
  level INTEGER NOT NULL DEFAULT 1,
  contentType TEXT NOT NULL DEFAULT 'default',
  language TEXT NOT NULL DEFAULT 'en',
  updatedAt TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS player_stats (
  userId INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  totalLettersTyped INTEGER NOT NULL DEFAULT 0,
  totalCorrect INTEGER NOT NULL DEFAULT 0,
  totalIncorrect INTEGER NOT NULL DEFAULT 0,
  bestWPM INTEGER NOT NULL DEFAULT 0,
  sessionsCount INTEGER NOT NULL DEFAULT 0,
  totalPlayTimeMs INTEGER NOT NULL DEFAULT 0,
  streakDays INTEGER NOT NULL DEFAULT 0,
  lastSessionAt TEXT
);

CREATE INDEX IF NOT EXISTS idx_player_stats_sessions ON player_stats (sessionsCount DESC);
