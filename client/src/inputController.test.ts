import { describe, expect, it } from "vitest";
import { KeyboardInputController } from "./inputController";

describe("KeyboardInputController - Mini PR 1 skeleton", () => {
  it("accepts correct key when only one non-modifier key is pressed", () => {
    const ctrl = new KeyboardInputController({ enabled: false });
    const down = ctrl.handleKeyDown({ key: "A", kind: "alphaNum", timestampMs: 1000 }, "a");
    expect(down.action).toBe("ACCEPTED_CORRECT");
  });

  it("tracks pressed keys and clears them on keyup", () => {
    const ctrl = new KeyboardInputController({ enabled: false });
    ctrl.handleKeyDown({ key: "A", kind: "alphaNum", timestampMs: 1000 }, "a");
    expect(ctrl.snapshot().pressedKeys).toContain("a");
    ctrl.handleKeyUp({ key: "A", kind: "alphaNum", timestampMs: 1010 }, "a");
    expect(ctrl.snapshot().pressedKeys).not.toContain("a");
  });

  it("treats modifier keys as non-input and excludes them from non-modifier count", () => {
    const ctrl = new KeyboardInputController({ enabled: true });
    const down = ctrl.handleKeyDown({ key: "Shift", kind: "modifier", timestampMs: 1000 }, "a");
    expect(down.action).toBe("IGNORED_NON_INPUT");
    expect(ctrl.snapshot().pressedNonModifiers.length).toBe(0);
  });
});

describe("KeyboardInputController - Mini PR 2 anti-smash gates", () => {
  it("ignores/chokes when two keys are pressed simultaneously", () => {
    const ctrl = new KeyboardInputController({ enabled: true, burstWindowMs: 120 });
    const first = ctrl.handleKeyDown({ key: "A", kind: "alphaNum", timestampMs: 1000 }, "a");
    expect(first.action).toBe("IGNORED_PENDING");
    const second = ctrl.handleKeyDown({ key: "S", kind: "alphaNum", timestampMs: 1020 }, "a");
    expect(second.action).toBe("IGNORED_SMASH");
    expect(second.isSmash).toBe(true);
  });

  it("ignores burst keydowns within burst window", () => {
    const ctrl = new KeyboardInputController({ enabled: true, burstWindowMs: 140 });
    ctrl.handleKeyDown({ key: "A", kind: "alphaNum", timestampMs: 1000 }, "a");
    ctrl.handleKeyUp({ key: "A", kind: "alphaNum", timestampMs: 1040 }, "a");
    const burst = ctrl.handleKeyDown({ key: "D", kind: "alphaNum", timestampMs: 1120 }, "d");
    expect(burst.action).toBe("IGNORED_SMASH");
  });

  it("requires clean release cycle before accepting next key (enabled mode)", () => {
    const ctrl = new KeyboardInputController({ enabled: true, burstWindowMs: 0 });
    const down1 = ctrl.handleKeyDown({ key: "A", kind: "alphaNum", timestampMs: 1000 }, "a");
    expect(down1.action).toBe("IGNORED_PENDING");
    const up1 = ctrl.handleKeyUp({ key: "A", kind: "alphaNum", timestampMs: 1010 }, "a");
    expect(up1.action).toBe("ACCEPTED_CORRECT");

    const down2 = ctrl.handleKeyDown({ key: "B", kind: "alphaNum", timestampMs: 1200 }, "b");
    expect(down2.action).toBe("IGNORED_PENDING");
    const up2 = ctrl.handleKeyUp({ key: "B", kind: "alphaNum", timestampMs: 1210 }, "b");
    expect(up2.action).toBe("ACCEPTED_CORRECT");
  });
});

describe("KeyboardInputController - Mini PR 3 freeze/escalation/reset", () => {
  it("returns frozen while freeze window is active after smash", () => {
    const ctrl = new KeyboardInputController({ enabled: true, baseFreezeMs: 400, burstWindowMs: 120 });
    ctrl.handleKeyDown({ key: "A", kind: "alphaNum", timestampMs: 1000 }, "a");
    const smash = ctrl.handleKeyDown({ key: "S", kind: "alphaNum", timestampMs: 1010 }, "a");
    expect(smash.action).toBe("IGNORED_SMASH");
    expect(smash.freezeMs).toBe(400);
    const frozen = ctrl.handleKeyDown({ key: "D", kind: "alphaNum", timestampMs: 1200 }, "d");
    expect(frozen.action).toBe("IGNORED_FROZEN");
  });

  it("escalates freeze duration on repeated smash events", () => {
    const ctrl = new KeyboardInputController({
      enabled: true,
      baseFreezeMs: 400,
      maxFreezeMs: 1200,
      burstWindowMs: 120,
      escalation: true
    });

    ctrl.handleKeyDown({ key: "A", kind: "alphaNum", timestampMs: 1000 }, "a");
    const smash1 = ctrl.handleKeyDown({ key: "S", kind: "alphaNum", timestampMs: 1010 }, "a");
    expect(smash1.freezeMs).toBe(400);
    ctrl.handleKeyUp({ key: "A", kind: "alphaNum", timestampMs: 1020 }, "a");
    ctrl.handleKeyUp({ key: "S", kind: "alphaNum", timestampMs: 1021 }, "a");

    ctrl.handleKeyDown({ key: "D", kind: "alphaNum", timestampMs: 1500 }, "d");
    const smash2 = ctrl.handleKeyDown({ key: "F", kind: "alphaNum", timestampMs: 1510 }, "d");
    expect(smash2.freezeMs).toBe(600);
  });

  it("resets escalation after clean accepted presses", () => {
    const ctrl = new KeyboardInputController({
      enabled: true,
      baseFreezeMs: 400,
      maxFreezeMs: 1200,
      burstWindowMs: 120,
      resetAfterCleanPresses: 2
    });

    ctrl.handleKeyDown({ key: "A", kind: "alphaNum", timestampMs: 1000 }, "a");
    ctrl.handleKeyDown({ key: "S", kind: "alphaNum", timestampMs: 1010 }, "a");
    ctrl.handleKeyUp({ key: "A", kind: "alphaNum", timestampMs: 1020 }, "a");
    ctrl.handleKeyUp({ key: "S", kind: "alphaNum", timestampMs: 1021 }, "a");

    ctrl.handleKeyDown({ key: "K", kind: "alphaNum", timestampMs: 1500 }, "k");
    expect(ctrl.handleKeyUp({ key: "K", kind: "alphaNum", timestampMs: 1510 }, "k").action).toBe("ACCEPTED_CORRECT");
    ctrl.handleKeyDown({ key: "L", kind: "alphaNum", timestampMs: 1700 }, "l");
    expect(ctrl.handleKeyUp({ key: "L", kind: "alphaNum", timestampMs: 1710 }, "l").action).toBe("ACCEPTED_CORRECT");

    ctrl.handleKeyDown({ key: "D", kind: "alphaNum", timestampMs: 2200 }, "d");
    const smash = ctrl.handleKeyDown({ key: "F", kind: "alphaNum", timestampMs: 2210 }, "d");
    expect(smash.freezeMs).toBe(400);
  });
});
