DROP INDEX IF EXISTS idx_vocabulary_packs_last_used_at;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'vocabulary_packs_source_check'
  ) THEN
    ALTER TABLE vocabulary_packs DROP CONSTRAINT vocabulary_packs_source_check;
  END IF;
END$$;

UPDATE vocabulary_packs
SET source = 'openai'
WHERE source = 'online_generated';

ALTER TABLE vocabulary_packs
  ADD CONSTRAINT vocabulary_packs_source_check
  CHECK(source IN ('manual','openai','imported'));

ALTER TABLE vocabulary_packs
  DROP COLUMN IF EXISTS last_used_at;

ALTER TABLE vocabulary_packs
  DROP COLUMN IF EXISTS tags;
