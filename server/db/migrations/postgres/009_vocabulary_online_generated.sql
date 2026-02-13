ALTER TABLE vocabulary_packs
  ADD COLUMN IF NOT EXISTS tags JSONB;

ALTER TABLE vocabulary_packs
  ADD COLUMN IF NOT EXISTS last_used_at TIMESTAMPTZ;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'vocabulary_packs_source_check'
  ) THEN
    ALTER TABLE vocabulary_packs DROP CONSTRAINT vocabulary_packs_source_check;
  END IF;
END$$;

ALTER TABLE vocabulary_packs
  ADD CONSTRAINT vocabulary_packs_source_check
  CHECK(source IN ('manual','openai','imported','online_generated'));

CREATE INDEX IF NOT EXISTS idx_vocabulary_packs_last_used_at
  ON vocabulary_packs (last_used_at DESC NULLS LAST);
