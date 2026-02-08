PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS leaderboard (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  playerName TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  contestType TEXT NOT NULL,
  level INTEGER NOT NULL,
  contentMode TEXT NOT NULL,
  duration INTEGER,
  taskTarget INTEGER,
  score REAL NOT NULL,
  accuracy REAL NOT NULL,
  cpm REAL NOT NULL,
  mistakes INTEGER NOT NULL,
  tasksCompleted INTEGER NOT NULL,
  timeSeconds REAL NOT NULL,
  maxStreak INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS vocab_packs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  packType TEXT NOT NULL,
  items TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 0,
  createdAt TEXT NOT NULL
);
