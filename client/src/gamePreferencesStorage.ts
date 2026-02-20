import { normalizePlayableSettings, toPreferencePayload, type GamePreferencesPayload, type GameSettings } from "./gameConfig";

export const GUEST_GAME_PREFS_KEY = "ktrain_guest_game_prefs_v1";
export const LEGACY_GUEST_GAME_PREFS_KEYS = ["ktrain_game_prefs_v1", "ktrain_game_preferences"];

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function parseStoredPayload(raw: string | null): GamePreferencesPayload | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const mode = parsed.mode === "contest" ? "contest" : "learning";
    const level = Math.max(1, Math.min(5, Number(parsed.level || 1)));
    const contentType = parsed.contentType === "vocab" ? "vocab" : "default";
    const language = String(parsed.language || "en").toLowerCase();
    const selectedPackId = parsed.selectedPackId ? String(parsed.selectedPackId) : null;
    return { mode, level, contentType, language, selectedPackId };
  } catch {
    return null;
  }
}

export function loadGuestGamePreferences(storage: StorageLike): { payload: GamePreferencesPayload | null; source: "current" | "legacy" | null } {
  const current = parseStoredPayload(storage.getItem(GUEST_GAME_PREFS_KEY));
  if (current) return { payload: current, source: "current" };

  for (const key of LEGACY_GUEST_GAME_PREFS_KEYS) {
    const legacy = parseStoredPayload(storage.getItem(key));
    if (legacy) return { payload: legacy, source: "legacy" };
  }

  return { payload: null, source: null };
}

export function applyGuestGamePreferences(base: GameSettings, payload: GamePreferencesPayload | null): GameSettings {
  if (!payload) return normalizePlayableSettings(base);
  return normalizePlayableSettings({
    ...base,
    mode: payload.mode,
    level: payload.level,
    contentMode: payload.contentType,
    language: payload.language,
    selectedPackId: payload.selectedPackId || null
  });
}

export function persistGuestGamePreferences(storage: StorageLike, settings: GameSettings): GamePreferencesPayload {
  const payload = toPreferencePayload(settings);
  storage.setItem(GUEST_GAME_PREFS_KEY, JSON.stringify(payload));
  for (const key of LEGACY_GUEST_GAME_PREFS_KEYS) {
    storage.removeItem(key);
  }
  return payload;
}
