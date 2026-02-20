DROP INDEX IF EXISTS idx_game_preferences_selected_pack;

ALTER TABLE game_preferences
  DROP COLUMN IF EXISTS selectedPackId;
