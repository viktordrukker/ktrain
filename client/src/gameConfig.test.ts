import { describe, expect, it } from "vitest";
import { normalizePlayableSettings, toPreferencePayload, toTaskGenerationPayload, type GameSettings } from "./gameConfig";

const base: GameSettings = {
  mode: "learning",
  level: 1,
  contestType: "time",
  duration: 60,
  taskTarget: 20,
  contentMode: "default",
  language: "en",
  playerName: "Tester",
  selectedPackId: null
};

describe("gameConfig mapping", () => {
  it("normalizes playable settings deterministically", () => {
    const normalized = normalizePlayableSettings({
      ...base,
      mode: "contest",
      level: 99,
      contentMode: "vocab",
      language: "RU",
      selectedPackId: "pack-1"
    });
    expect(normalized.mode).toBe("contest");
    expect(normalized.level).toBe(5);
    expect(normalized.contentMode).toBe("vocab");
    expect(normalized.language).toBe("ru");
    expect(normalized.selectedPackId).toBe("pack-1");
  });

  it("builds preference payload from normalized settings", () => {
    const payload = toPreferencePayload({
      ...base,
      level: 0,
      language: "EN",
      contentMode: "vocab",
      selectedPackId: "abc"
    });
    expect(payload).toEqual({
      mode: "learning",
      level: 1,
      contentType: "vocab",
      language: "en",
      selectedPackId: "abc"
    });
  });

  it("maps task generation payload with count/session/telemetry guards", () => {
    const payload = toTaskGenerationPayload(
      {
        ...base,
        level: 3,
        contentMode: "vocab",
        language: "RU",
        selectedPackId: "pack-42"
      },
      2,
      "session-7",
      { cpm: 123 }
    );
    expect(payload.level).toBe(3);
    expect(payload.count).toBe(5);
    expect(payload.contentMode).toBe("vocab");
    expect(payload.language).toBe("ru");
    expect(payload.sessionId).toBe("session-7");
    expect(payload.selectedPackId).toBe("pack-42");
    expect(payload.telemetry.cpm).toBe(123);
  });
});
