CREATE TABLE IF NOT EXISTS vocabulary_packs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  language TEXT NOT NULL,
  level INTEGER NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('words','sentences','fiction','code')),
  status TEXT NOT NULL CHECK(status IN ('draft','published','archived')),
  source TEXT NOT NULL CHECK(source IN ('manual','openai','imported')),
  version INTEGER NOT NULL DEFAULT 1,
  generator_config TEXT,
  metadata TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS vocabulary_entries (
  id TEXT PRIMARY KEY,
  pack_id TEXT NOT NULL REFERENCES vocabulary_packs(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  order_index INTEGER NOT NULL,
  difficulty_score REAL,
  tags TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS vocabulary_pack_versions (
  id TEXT PRIMARY KEY,
  pack_id TEXT NOT NULL REFERENCES vocabulary_packs(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  snapshot_json TEXT NOT NULL,
  change_note TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_vocabulary_packs_lookup ON vocabulary_packs (language, level, type, status, source, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_vocabulary_entries_pack ON vocabulary_entries (pack_id, order_index ASC);
CREATE INDEX IF NOT EXISTS idx_vocabulary_versions_pack ON vocabulary_pack_versions (pack_id, version DESC);
