import { describe, expect, it } from "vitest";
import { KeyboardInputController } from "./inputController";

type SimEvent = {
  type: "down" | "up";
  key: string;
  ts: number;
};

function runSingleTargetSession(events: SimEvent[], target = "a") {
  const ctrl = new KeyboardInputController({
    enabled: true,
    burstWindowMs: 120,
    baseFreezeMs: 400,
    maxFreezeMs: 1200,
    requireAllKeysUpBetweenAccepts: true
  });
  let completions = 0;
  for (const event of events) {
    const result = event.type === "down"
      ? ctrl.handleKeyDown({ key: event.key, kind: "alphaNum", timestampMs: event.ts }, target)
      : ctrl.handleKeyUp({ key: event.key, kind: "alphaNum", timestampMs: event.ts }, target);
    if (result.action === "ACCEPTED_CORRECT") {
      completions += 1;
    }
  }
  return { completions };
}

describe("KeyboardInputController integration - gameplay target flow", () => {
  it("does not complete task on smash, then completes on clean press/release", () => {
    const smashed = runSingleTargetSession([
      { type: "down", key: "A", ts: 1000 },
      { type: "down", key: "S", ts: 1010 },
      { type: "up", key: "A", ts: 1020 },
      { type: "up", key: "S", ts: 1030 }
    ]);
    expect(smashed.completions).toBe(0);

    const clean = runSingleTargetSession([
      { type: "down", key: "A", ts: 1600 },
      { type: "up", key: "A", ts: 1610 }
    ]);
    expect(clean.completions).toBe(1);
  });
});
