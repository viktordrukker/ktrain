import { InputResult } from "./inputController";

export type AntiSmashUiCue = {
  active: boolean;
  showHint: boolean;
  shouldJiggle: boolean;
  shouldPlaySound: boolean;
  freezeMs: number;
  hintLabel: string;
};

const INACTIVE_CUE: AntiSmashUiCue = {
  active: false,
  showHint: false,
  shouldJiggle: false,
  shouldPlaySound: false,
  freezeMs: 0,
  hintLabel: ""
};

export function deriveAntiSmashUiCue(result: Pick<InputResult, "action" | "freezeMs">, soundEnabled: boolean): AntiSmashUiCue {
  if (result.action !== "IGNORED_SMASH") return INACTIVE_CUE;
  const freezeMs = Math.max(300, Math.min(1200, Number(result.freezeMs || 0)));
  return {
    active: true,
    showHint: true,
    shouldJiggle: true,
    shouldPlaySound: Boolean(soundEnabled),
    freezeMs,
    hintLabel: "One key"
  };
}
