export type InputKind = "alphaNum" | "space" | "modifier" | "navigation" | "other" | "punct";

export type AntiSmashConfig = {
  enabled: boolean;
  maxSimultaneousKeysAllowed: number;
  burstWindowMs: number;
  requireAllKeysUpBetweenAccepts: boolean;
  escalation: boolean;
  maxFreezeMs: number;
  baseFreezeMs: number;
  resetAfterCleanPresses: number;
  penalizeScore: boolean;
  breakStreak: boolean;
};

export type InputAction =
  | "ACCEPTED_CORRECT"
  | "ACCEPTED_WRONG"
  | "IGNORED_SMASH"
  | "IGNORED_FROZEN"
  | "IGNORED_REPEAT"
  | "IGNORED_NON_INPUT"
  | "IGNORED_PENDING"
  | "IGNORED_WAIT_RELEASE";

export type InputResult = {
  action: InputAction;
  normalizedKey: string;
  freezeMs: number;
  isSmash: boolean;
};

export type KeyInputEvent = {
  key: string;
  kind: InputKind;
  repeat?: boolean;
  timestampMs?: number;
};

type InternalState = {
  pressedKeys: Set<string>;
  pressedNonModifiers: Set<string>;
  pendingCorrectKey: string | null;
  waitingForAllKeysUp: boolean;
  lastNonModifierKeyDownAt: number;
  freezeUntilMs: number;
  smashTimestamps: number[];
  cleanPresses: number;
};

const modifierKeys = new Set(["shift", "control", "ctrl", "alt", "meta", "altgraph", "capslock"]);

export const DEFAULT_ANTI_SMASH_CONFIG: AntiSmashConfig = {
  enabled: false,
  maxSimultaneousKeysAllowed: 1,
  burstWindowMs: 120,
  requireAllKeysUpBetweenAccepts: true,
  escalation: true,
  maxFreezeMs: 1200,
  baseFreezeMs: 400,
  resetAfterCleanPresses: 5,
  penalizeScore: false,
  breakStreak: false
};

function normalizeKey(rawKey: string): string {
  if (rawKey === " ") return " ";
  return String(rawKey || "").toLowerCase();
}

function sanitizeConfig(input: Partial<AntiSmashConfig> | null | undefined): AntiSmashConfig {
  const cfg = { ...DEFAULT_ANTI_SMASH_CONFIG, ...(input || {}) };
  return {
    enabled: Boolean(cfg.enabled),
    maxSimultaneousKeysAllowed: Math.max(1, Math.min(3, Number(cfg.maxSimultaneousKeysAllowed || 1))),
    burstWindowMs: Math.max(0, Math.min(500, Number(cfg.burstWindowMs || 0))),
    requireAllKeysUpBetweenAccepts: Boolean(cfg.requireAllKeysUpBetweenAccepts),
    escalation: Boolean(cfg.escalation),
    maxFreezeMs: Math.max(100, Math.min(5000, Number(cfg.maxFreezeMs || 1200))),
    baseFreezeMs: Math.max(0, Math.min(3000, Number(cfg.baseFreezeMs || 400))),
    resetAfterCleanPresses: Math.max(1, Math.min(50, Number(cfg.resetAfterCleanPresses || 5))),
    penalizeScore: Boolean(cfg.penalizeScore),
    breakStreak: Boolean(cfg.breakStreak)
  };
}

export class KeyboardInputController {
  private config: AntiSmashConfig;
  private state: InternalState;

  constructor(config: Partial<AntiSmashConfig> = {}) {
    this.config = sanitizeConfig(config);
    this.state = this.createInitialState();
  }

  private createInitialState(): InternalState {
    return {
      pressedKeys: new Set(),
      pressedNonModifiers: new Set(),
      pendingCorrectKey: null,
      waitingForAllKeysUp: false,
      lastNonModifierKeyDownAt: 0,
      freezeUntilMs: 0,
      smashTimestamps: [],
      cleanPresses: 0
    };
  }

  public updateConfig(config: Partial<AntiSmashConfig>) {
    this.config = sanitizeConfig({ ...this.config, ...config });
  }

  public reset() {
    this.state = this.createInitialState();
  }

  public snapshot() {
    return {
      pressedKeys: Array.from(this.state.pressedKeys),
      pressedNonModifiers: Array.from(this.state.pressedNonModifiers),
      pendingCorrectKey: this.state.pendingCorrectKey,
      waitingForAllKeysUp: this.state.waitingForAllKeysUp,
      freezeUntilMs: this.state.freezeUntilMs,
      cleanPresses: this.state.cleanPresses
    };
  }

  private now(inputMs?: number): number {
    return Number(inputMs || Date.now());
  }

  private isModifier(kind: InputKind, normalizedKey: string): boolean {
    return kind === "modifier" || modifierKeys.has(normalizedKey);
  }

  private result(action: InputAction, normalizedKey: string, freezeMs = 0, isSmash = false): InputResult {
    return { action, normalizedKey, freezeMs, isSmash };
  }

  private triggerSmash(nowMs: number, normalizedKey: string): InputResult {
    const cutoff = nowMs - 10_000;
    this.state.smashTimestamps = this.state.smashTimestamps.filter((ts) => ts >= cutoff);
    this.state.smashTimestamps.push(nowMs);
    this.state.cleanPresses = 0;
    this.state.pendingCorrectKey = null;
    const smashCount = this.state.smashTimestamps.length;
    const escalationStep = this.config.escalation ? Math.max(0, smashCount - 1) * 200 : 0;
    const freezeMs = Math.min(this.config.maxFreezeMs, this.config.baseFreezeMs + escalationStep);
    this.state.freezeUntilMs = nowMs + freezeMs;
    return this.result("IGNORED_SMASH", normalizedKey, freezeMs, true);
  }

  private maybeResetEscalationAfterCleanPress() {
    if (this.state.cleanPresses >= this.config.resetAfterCleanPresses) {
      this.state.cleanPresses = 0;
      this.state.smashTimestamps = [];
    }
  }

  public handleKeyDown(event: KeyInputEvent, expectedKey: string | null): InputResult {
    const nowMs = this.now(event.timestampMs);
    const normalizedKey = normalizeKey(event.key);
    const modifier = this.isModifier(event.kind, normalizedKey);

    if (this.state.pressedKeys.has(normalizedKey) || event.repeat) {
      return this.result("IGNORED_REPEAT", normalizedKey);
    }

    this.state.pressedKeys.add(normalizedKey);
    if (!modifier) this.state.pressedNonModifiers.add(normalizedKey);

    if (modifier || event.kind === "navigation" || event.kind === "other" || event.kind === "punct") {
      return this.result("IGNORED_NON_INPUT", normalizedKey);
    }

    if (this.config.enabled && nowMs < this.state.freezeUntilMs) {
      return this.result("IGNORED_FROZEN", normalizedKey);
    }

    if (this.config.enabled && this.config.requireAllKeysUpBetweenAccepts && this.state.waitingForAllKeysUp) {
      return this.triggerSmash(nowMs, normalizedKey);
    }

    if (this.config.enabled && this.state.pressedNonModifiers.size > this.config.maxSimultaneousKeysAllowed) {
      return this.triggerSmash(nowMs, normalizedKey);
    }

    if (
      this.config.enabled
      && this.state.lastNonModifierKeyDownAt > 0
      && nowMs - this.state.lastNonModifierKeyDownAt <= this.config.burstWindowMs
    ) {
      this.state.lastNonModifierKeyDownAt = nowMs;
      return this.triggerSmash(nowMs, normalizedKey);
    }

    this.state.lastNonModifierKeyDownAt = nowMs;

    const expectedNormalized = expectedKey === null ? null : normalizeKey(expectedKey);
    if (!expectedNormalized) return this.result("IGNORED_NON_INPUT", normalizedKey);
    if (normalizedKey !== expectedNormalized) return this.result("ACCEPTED_WRONG", normalizedKey);

    if (this.config.enabled) {
      this.state.pendingCorrectKey = normalizedKey;
      return this.result("IGNORED_PENDING", normalizedKey);
    }

    this.state.waitingForAllKeysUp = this.config.requireAllKeysUpBetweenAccepts;
    this.state.cleanPresses += 1;
    this.maybeResetEscalationAfterCleanPress();
    return this.result("ACCEPTED_CORRECT", normalizedKey);
  }

  public handleKeyUp(event: KeyInputEvent, expectedKey: string | null): InputResult {
    const normalizedKey = normalizeKey(event.key);
    this.state.pressedKeys.delete(normalizedKey);
    if (!this.isModifier(event.kind, normalizedKey)) {
      this.state.pressedNonModifiers.delete(normalizedKey);
    }

    if (this.state.pressedNonModifiers.size === 0) {
      this.state.waitingForAllKeysUp = false;
    }

    if (!this.config.enabled) return this.result("IGNORED_NON_INPUT", normalizedKey);

    const expectedNormalized = expectedKey === null ? null : normalizeKey(expectedKey);
    if (!expectedNormalized) {
      this.state.pendingCorrectKey = null;
      return this.result("IGNORED_NON_INPUT", normalizedKey);
    }

    if (this.state.pendingCorrectKey && normalizedKey === this.state.pendingCorrectKey) {
      if (this.state.pressedNonModifiers.size > 0) {
        return this.result("IGNORED_WAIT_RELEASE", normalizedKey);
      }
      if (normalizeKey(expectedNormalized) !== normalizedKey) {
        this.state.pendingCorrectKey = null;
        return this.result("ACCEPTED_WRONG", normalizedKey);
      }
      this.state.pendingCorrectKey = null;
      this.state.waitingForAllKeysUp = this.config.requireAllKeysUpBetweenAccepts
        ? this.state.pressedNonModifiers.size > 0
        : false;
      this.state.cleanPresses += 1;
      this.maybeResetEscalationAfterCleanPress();
      return this.result("ACCEPTED_CORRECT", normalizedKey);
    }

    return this.result("IGNORED_NON_INPUT", normalizedKey);
  }
}

export function normalizeInputKey(rawKey: string) {
  return normalizeKey(rawKey);
}
