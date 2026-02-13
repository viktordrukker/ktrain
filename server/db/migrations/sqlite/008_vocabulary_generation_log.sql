CREATE TABLE IF NOT EXISTS vocabulary_generation_log (
  id TEXT PRIMARY KEY,
  pack_id TEXT REFERENCES vocabulary_packs(id) ON DELETE CASCADE,
  request_id TEXT,
  created_at TEXT NOT NULL,
  language TEXT NOT NULL,
  level INTEGER NOT NULL,
  type TEXT NOT NULL,
  requested_count INTEGER NOT NULL,
  topic TEXT,
  model TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  raw_output TEXT,
  parsed_count INTEGER NOT NULL DEFAULT 0,
  final_count INTEGER NOT NULL DEFAULT 0,
  validation_summary TEXT,
  status TEXT NOT NULL CHECK(status IN ('success','failed')),
  error_code TEXT,
  error_message TEXT
);

CREATE INDEX IF NOT EXISTS idx_vocab_gen_log_pack ON vocabulary_generation_log (pack_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_vocab_gen_log_request ON vocabulary_generation_log (request_id);
