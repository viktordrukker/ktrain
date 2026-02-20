import { describe, expect, it } from "vitest";
import { applyGuestGamePreferences, GUEST_GAME_PREFS_KEY, loadGuestGamePreferences, persistGuestGamePreferences } from "./gamePreferencesStorage";
import type { GameSettings } from "./gameConfig";

function makeStorage(initial: Record<string, string> = {}) {
  const map = new Map<string, string>(Object.entries(initial));
  return {
    getItem(key: string) {
      return map.has(key) ? map.get(key)! : null;
    },
    setItem(key: string, value: string) {
      map.set(key, value);
    },
    removeItem(key: string) {
      map.delete(key);
    }
  };
}

const base: GameSettings = {
  mode: "learning",
  level: 1,
  contestType: "time",
  duration: 60,
  taskTarget: 20,
  contentMode: "default",
  language: "en",
  playerName: "",
  selectedPackId: null
};

describe("gamePreferencesStorage", () => {
  it("loads current guest preferences key", () => {
    const storage = makeStorage({
      [GUEST_GAME_PREFS_KEY]: JSON.stringify({
        mode: "contest",
        level: 5,
        contentType: "vocab",
        language: "RU",
        selectedPackId: "pack-77"
      })
    });
    const loaded = loadGuestGamePreferences(storage);
    expect(loaded.source).toBe("current");
    expect(loaded.payload).toEqual({
      mode: "contest",
      level: 5,
      contentType: "vocab",
      language: "ru",
      selectedPackId: "pack-77"
    });
  });

  it("falls back to legacy keys and normalizes", () => {
    const storage = makeStorage({
      ktrain_game_preferences: JSON.stringify({
        mode: "learning",
        level: 0,
        contentType: "default",
        language: "EN"
      })
    });
    const loaded = loadGuestGamePreferences(storage);
    expect(loaded.source).toBe("legacy");
    const hydrated = applyGuestGamePreferences(base, loaded.payload);
    expect(hydrated.level).toBe(1);
    expect(hydrated.language).toBe("en");
  });

  it("persists payload and clears legacy keys", () => {
    const storage = makeStorage({
      ktrain_game_preferences: "{\"mode\":\"contest\"}"
    });
    const payload = persistGuestGamePreferences(storage, {
      ...base,
      mode: "contest",
      level: 3,
      contentMode: "vocab",
      language: "RU",
      selectedPackId: "pack-3"
    });
    expect(payload).toEqual({
      mode: "contest",
      level: 3,
      contentType: "vocab",
      language: "ru",
      selectedPackId: "pack-3"
    });
    expect(storage.getItem("ktrain_game_preferences")).toBeNull();
    expect(storage.getItem(GUEST_GAME_PREFS_KEY)).not.toBeNull();
  });
});
