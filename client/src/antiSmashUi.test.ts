import { describe, expect, it } from "vitest";
import { deriveAntiSmashUiCue } from "./antiSmashUi";

describe("deriveAntiSmashUiCue", () => {
  it("returns inactive cue for non-smash actions", () => {
    const cue = deriveAntiSmashUiCue({ action: "IGNORED_REPEAT", freezeMs: 0 }, true);
    expect(cue.active).toBe(false);
    expect(cue.showHint).toBe(false);
    expect(cue.shouldPlaySound).toBe(false);
  });

  it("returns active playful cue for smash and respects sound setting", () => {
    const cue = deriveAntiSmashUiCue({ action: "IGNORED_SMASH", freezeMs: 450 }, true);
    expect(cue.active).toBe(true);
    expect(cue.showHint).toBe(true);
    expect(cue.shouldJiggle).toBe(true);
    expect(cue.shouldPlaySound).toBe(true);
    expect(cue.freezeMs).toBe(450);
    expect(cue.hintLabel).toBe("One key");
  });

  it("clamps freeze duration for hint display", () => {
    const low = deriveAntiSmashUiCue({ action: "IGNORED_SMASH", freezeMs: 50 }, false);
    const high = deriveAntiSmashUiCue({ action: "IGNORED_SMASH", freezeMs: 6000 }, false);
    expect(low.freezeMs).toBe(300);
    expect(high.freezeMs).toBe(1200);
  });
});
