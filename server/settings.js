const SETTINGS_KEY = "app_settings_v2";
const SETTINGS_VERSION = 2;

const DEFAULT_SETTINGS = {
  version: SETTINGS_VERSION,
  textSize: "xlarge",
  autoFitText: true,
  theme: "warm_playful",
  lowStimulation: false,
  visibilityGuard: "aaa",
  customTheme: {
    background: "#141414",
    backgroundAlt: "#1f1b16",
    panel: "#2d2722",
    text: "#fffbe9",
    mutedText: "#cbc3ad",
    accent: "#f9c74f",
    highlight: "#90be6d",
    correct: "#2ecc71",
    mistake: "#f94144"
  },
  flatTheme: false,
  correctEffects: {
    visualSet: "stars",
    randomizeVisual: false,
    animated: true,
    transformLetter: true,
    durationMs: 650,
    sound: "chime",
    randomizeSound: false,
    volume: 0.4,
    intensity: "medium",
    variation: "small"
  },
  soundEnabled: true,
  agePreset: "custom",
  animationSpeed: 1,
  stagePadding: "medium",
  languageReminder: true,
  perCharProgress: true,
  wrongCharBehavior: "block",
  streakPolicy: "task_fail",
  rollingCart: "off",
  rollingIntensity: "minimal",
  spaceRequired: false,
  debugLayout: false,
  showBounds: false,
  apcaDeveloper: false,
  warnOnExitContest: true,
  maxAllowedLevel: 5,
  differentiateZero: true,
  zeroStyle: "dot",
  protectFunctionKeys: true
};

const TEXT_SIZES = ["small", "medium", "large", "xlarge"];
const THEMES = ["high_contrast", "soft_pastel", "dark_calm", "warm_playful", "custom"];
const GUARDS = ["off", "aa", "aaa"];
const VISUAL_SETS = ["stars", "hearts", "balloons", "smiles", "confetti"];
const SOUNDS = ["chime", "pop", "bell", "sparkle", "off"];
const INTENSITIES = ["very_low", "low", "medium", "high"];
const VARIATIONS = ["same", "small", "high"];
const STAGE_PADDING = ["small", "medium", "large"];
const WRONG_BEHAVIOR = ["block", "retry", "skip"];
const STREAK_POLICY = ["first_wrong", "task_fail", "never"];
const ROLLING_CART = ["off", "on"];
const ROLLING_INTENSITY = ["minimal", "normal"];
const ZERO_STYLE = ["dot", "slashed", "dotted"];

function cleanColor(value, fallback) {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(trimmed) || /^#[0-9a-fA-F]{3}$/.test(trimmed)) {
    return trimmed;
  }
  return fallback;
}

function clampNumber(value, min, max, fallback) {
  const num = Number(value);
  if (Number.isNaN(num)) return fallback;
  return Math.min(Math.max(num, min), max);
}

function sanitizeSettings(input = {}) {
  const next = {
    ...DEFAULT_SETTINGS,
    ...input,
    customTheme: {
      ...DEFAULT_SETTINGS.customTheme,
      ...(input.customTheme || {})
    },
    correctEffects: {
      ...DEFAULT_SETTINGS.correctEffects,
      ...(input.correctEffects || {})
    }
  };

  next.textSize = TEXT_SIZES.includes(next.textSize) ? next.textSize : DEFAULT_SETTINGS.textSize;
  next.autoFitText = Boolean(next.autoFitText);
  next.theme = THEMES.includes(next.theme) ? next.theme : DEFAULT_SETTINGS.theme;
  next.lowStimulation = Boolean(next.lowStimulation);
  next.visibilityGuard = GUARDS.includes(next.visibilityGuard) ? next.visibilityGuard : DEFAULT_SETTINGS.visibilityGuard;

  next.customTheme.background = cleanColor(next.customTheme.background, DEFAULT_SETTINGS.customTheme.background);
  next.customTheme.backgroundAlt = cleanColor(next.customTheme.backgroundAlt, DEFAULT_SETTINGS.customTheme.backgroundAlt);
  next.customTheme.panel = cleanColor(next.customTheme.panel, DEFAULT_SETTINGS.customTheme.panel);
  next.customTheme.text = cleanColor(next.customTheme.text, DEFAULT_SETTINGS.customTheme.text);
  next.customTheme.mutedText = cleanColor(next.customTheme.mutedText, DEFAULT_SETTINGS.customTheme.mutedText);
  next.customTheme.accent = cleanColor(next.customTheme.accent, DEFAULT_SETTINGS.customTheme.accent);
  next.customTheme.highlight = cleanColor(next.customTheme.highlight, DEFAULT_SETTINGS.customTheme.highlight);
  next.customTheme.correct = cleanColor(next.customTheme.correct, DEFAULT_SETTINGS.customTheme.correct);
  next.customTheme.mistake = cleanColor(next.customTheme.mistake, DEFAULT_SETTINGS.customTheme.mistake);
  next.flatTheme = Boolean(next.flatTheme);

  next.correctEffects.visualSet = VISUAL_SETS.includes(next.correctEffects.visualSet)
    ? next.correctEffects.visualSet
    : DEFAULT_SETTINGS.correctEffects.visualSet;
  next.correctEffects.randomizeVisual = Boolean(next.correctEffects.randomizeVisual);
  next.correctEffects.animated = Boolean(next.correctEffects.animated);
  next.correctEffects.transformLetter = Boolean(next.correctEffects.transformLetter);
  next.correctEffects.durationMs = clampNumber(next.correctEffects.durationMs, 250, 2000, DEFAULT_SETTINGS.correctEffects.durationMs);
  next.correctEffects.sound = SOUNDS.includes(next.correctEffects.sound) ? next.correctEffects.sound : DEFAULT_SETTINGS.correctEffects.sound;
  next.correctEffects.randomizeSound = Boolean(next.correctEffects.randomizeSound);
  next.correctEffects.volume = clampNumber(next.correctEffects.volume, 0, 1, DEFAULT_SETTINGS.correctEffects.volume);
  next.correctEffects.intensity = INTENSITIES.includes(next.correctEffects.intensity)
    ? next.correctEffects.intensity
    : DEFAULT_SETTINGS.correctEffects.intensity;
  next.correctEffects.variation = VARIATIONS.includes(next.correctEffects.variation)
    ? next.correctEffects.variation
    : DEFAULT_SETTINGS.correctEffects.variation;

  next.soundEnabled = Boolean(next.soundEnabled);
  next.agePreset = typeof next.agePreset === "string" ? next.agePreset : DEFAULT_SETTINGS.agePreset;
  next.animationSpeed = clampNumber(next.animationSpeed, 0.6, 1.4, DEFAULT_SETTINGS.animationSpeed);

  next.stagePadding = STAGE_PADDING.includes(next.stagePadding) ? next.stagePadding : DEFAULT_SETTINGS.stagePadding;
  next.languageReminder = Boolean(next.languageReminder);
  next.perCharProgress = Boolean(next.perCharProgress);
  next.wrongCharBehavior = WRONG_BEHAVIOR.includes(next.wrongCharBehavior) ? next.wrongCharBehavior : DEFAULT_SETTINGS.wrongCharBehavior;
  next.streakPolicy = STREAK_POLICY.includes(next.streakPolicy) ? next.streakPolicy : DEFAULT_SETTINGS.streakPolicy;
  next.rollingCart = ROLLING_CART.includes(next.rollingCart) ? next.rollingCart : DEFAULT_SETTINGS.rollingCart;
  next.rollingIntensity = ROLLING_INTENSITY.includes(next.rollingIntensity) ? next.rollingIntensity : DEFAULT_SETTINGS.rollingIntensity;
  next.spaceRequired = Boolean(next.spaceRequired);

  next.debugLayout = Boolean(next.debugLayout);
  next.showBounds = Boolean(next.showBounds);
  next.apcaDeveloper = Boolean(next.apcaDeveloper);
  next.warnOnExitContest = Boolean(next.warnOnExitContest);
  next.maxAllowedLevel = clampNumber(next.maxAllowedLevel, 1, 5, DEFAULT_SETTINGS.maxAllowedLevel);
  next.allowedLevels = Array.from({ length: next.maxAllowedLevel }, (_, i) => i + 1);
  next.differentiateZero = Boolean(next.differentiateZero);
  next.zeroStyle = ZERO_STYLE.includes(next.zeroStyle) ? next.zeroStyle : DEFAULT_SETTINGS.zeroStyle;
  next.protectFunctionKeys = Boolean(next.protectFunctionKeys);

  next.version = SETTINGS_VERSION;
  return next;
}

async function loadSettings(repo) {
  if (repo.getConfig) {
    const row = await repo.getConfig("app.settings", "global", "global");
    if (row?.valueJson) {
      return sanitizeSettings(row.valueJson || {});
    }
  }
  const raw = await repo.getSetting(SETTINGS_KEY);
  if (!raw) return DEFAULT_SETTINGS;
  try {
    return sanitizeSettings(JSON.parse(raw) || {});
  } catch {
    return DEFAULT_SETTINGS;
  }
}

async function saveSettings(repo, input) {
  const safe = sanitizeSettings(input || {});
  if (repo.setConfig) {
    await repo.setConfig("app.settings", "global", "global", safe, "settings_api");
  }
  await repo.setSetting(SETTINGS_KEY, JSON.stringify(safe));
  return safe;
}

module.exports = {
  DEFAULT_SETTINGS,
  loadSettings,
  saveSettings,
  sanitizeSettings
};
