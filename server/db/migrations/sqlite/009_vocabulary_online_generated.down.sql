PRAGMA foreign_keys = OFF;
BEGIN TRANSACTION;

CREATE TABLE vocabulary_packs_old (
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

INSERT INTO vocabulary_packs_old (
  id, name, language, level, type, status, source, version,
  generator_config, metadata, created_at, updated_at
)
SELECT
  id, name, language, level, type, status,
  CASE WHEN source = 'online_generated' THEN 'openai' ELSE source END,
  version, generator_config, metadata, created_at, updated_at
FROM vocabulary_packs;

DROP TABLE vocabulary_packs;
ALTER TABLE vocabulary_packs_old RENAME TO vocabulary_packs;

CREATE INDEX IF NOT EXISTS idx_vocabulary_packs_lookup ON vocabulary_packs (language, level, type, status, source, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_vocabulary_entries_pack ON vocabulary_entries (pack_id, order_index ASC);
CREATE INDEX IF NOT EXISTS idx_vocabulary_versions_pack ON vocabulary_pack_versions (pack_id, version DESC);

COMMIT;
PRAGMA foreign_keys = ON;
