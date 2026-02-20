ALTER TABLE game_preferences
  ADD COLUMN IF NOT EXISTS selectedPackId TEXT;

CREATE INDEX IF NOT EXISTS idx_game_preferences_selected_pack
  ON game_preferences (selectedPackId);
