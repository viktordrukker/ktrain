export type Mode = "learning" | "contest";
export type ContestType = "time" | "tasks";
export type ContentMode = "default" | "vocab";

export type GameSettings = {
  mode: Mode;
  level: number;
  contestType: ContestType;
  duration: 30 | 60 | 120;
  taskTarget: 10 | 20 | 50;
  contentMode: ContentMode;
  language: string;
  playerName: string;
  selectedPackId?: string | null;
};

export type GamePreferencesPayload = {
  mode: Mode;
  level: number;
  contentType: ContentMode;
  language: string;
  selectedPackId?: string | null;
};

export function normalizePlayableSettings(value: GameSettings): GameSettings {
  return {
    ...value,
    mode: value.mode === "contest" ? "contest" : "learning",
    level: Math.max(1, Math.min(5, Number(value.level || 1))),
    contentMode: value.contentMode === "vocab" ? "vocab" : "default",
    language: String(value.language || "en").toLowerCase(),
    selectedPackId: value.selectedPackId ? String(value.selectedPackId) : null
  };
}

export function toPreferencePayload(value: GameSettings): GamePreferencesPayload {
  const normalized = normalizePlayableSettings(value);
  return {
    mode: normalized.mode,
    level: normalized.level,
    contentType: normalized.contentMode,
    language: normalized.language,
    selectedPackId: normalized.selectedPackId || null
  };
}

export function toTaskGenerationPayload(
  value: GameSettings,
  count: number,
  sessionId: string,
  telemetry: { cpm?: number } = {}
) {
  const normalized = normalizePlayableSettings(value);
  return {
    level: normalized.level,
    count: Math.max(5, Math.min(100, Number(count || 10))),
    contentMode: normalized.contentMode,
    language: normalized.language,
    sessionId: String(sessionId || ""),
    selectedPackId: normalized.selectedPackId || null,
    telemetry: {
      cpm: Number(telemetry?.cpm || 0)
    }
  };
}

