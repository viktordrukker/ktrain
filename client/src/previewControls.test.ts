import { describe, expect, it } from "vitest";
import { getPreviewControlState } from "./previewControls";

describe("preview controls state", () => {
  it("disables sound preview when sound is globally disabled", () => {
    const state = getPreviewControlState({
      soundEnabled: false,
      mistakeStyle: "gentle",
      correctEffects: {
        randomizeSound: false,
        sound: "chime"
      }
    });
    expect(state.canPlaySound).toBe(false);
    expect(state.playSoundHint).toContain("Enable Sound");
  });

  it("enables sound preview when random sound is active", () => {
    const state = getPreviewControlState({
      soundEnabled: true,
      mistakeStyle: "normal",
      correctEffects: {
        randomizeSound: true,
        sound: "off"
      }
    });
    expect(state.canPlaySound).toBe(true);
    expect(state.playSoundHint).toContain("Plays a sample");
  });
});
