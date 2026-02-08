export type GuardLevel = "off" | "aa" | "aaa";

export type ContrastPair = {
  name: string;
  fg: string;
  bg: string;
  ratio: number;
  passAA: boolean;
  passAAA: boolean;
};

export type ContrastReport = {
  level: GuardLevel;
  pairs: ContrastPair[];
  adjusted: boolean;
  message?: string;
  apca?: number;
};

const cache = new Map<string, { theme: any; report: ContrastReport }>();

function hexToRgb(hex: string) {
  const value = hex.replace("#", "");
  const r = parseInt(value.slice(0, 2), 16) / 255;
  const g = parseInt(value.slice(2, 4), 16) / 255;
  const b = parseInt(value.slice(4, 6), 16) / 255;
  return { r, g, b };
}

function srgbToLinear(channel: number) {
  return channel <= 0.03928 ? channel / 12.92 : Math.pow((channel + 0.055) / 1.055, 2.4);
}

export function relativeLuminance(hex: string) {
  const { r, g, b } = hexToRgb(hex);
  const R = srgbToLinear(r);
  const G = srgbToLinear(g);
  const B = srgbToLinear(b);
  return 0.2126 * R + 0.7152 * G + 0.0722 * B;
}

export function contrastRatio(fg: string, bg: string) {
  const L1 = relativeLuminance(fg);
  const L2 = relativeLuminance(bg);
  const lighter = Math.max(L1, L2);
  const darker = Math.min(L1, L2);
  return (lighter + 0.05) / (darker + 0.05);
}

function hexToHsl(hex: string) {
  const { r, g, b } = hexToRgb(hex);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0;
  let s = 0;
  const l = (max + min) / 2;

  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r:
        h = (g - b) / d + (g < b ? 6 : 0);
        break;
      case g:
        h = (b - r) / d + 2;
        break;
      case b:
        h = (r - g) / d + 4;
        break;
    }
    h /= 6;
  }

  return { h, s, l };
}

function hslToHex(h: number, s: number, l: number) {
  const hue2rgb = (p: number, q: number, t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };

  let r = l;
  let g = l;
  let b = l;

  if (s !== 0) {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue2rgb(p, q, h + 1 / 3);
    g = hue2rgb(p, q, h);
    b = hue2rgb(p, q, h - 1 / 3);
  }

  const toHex = (x: number) => Math.round(x * 255).toString(16).padStart(2, "0");
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function adjustForContrast(fg: string, bg: string, target: number) {
  if (contrastRatio(fg, bg) >= target) return fg;
  const { h, s, l } = hexToHsl(fg);
  const bgLum = relativeLuminance(bg);
  const direction = bgLum < 0.5 ? 1 : -1;
  let nextL = l;
  for (let i = 0; i < 60; i += 1) {
    nextL = Math.min(1, Math.max(0, nextL + direction * 0.02));
    const candidate = hslToHex(h, s, nextL);
    if (contrastRatio(candidate, bg) >= target) return candidate;
  }
  const fallback = bgLum < 0.5 ? "#FFFFFF" : "#000000";
  return fallback;
}

export function applyVisibilityGuard(theme: any, level: GuardLevel) {
  const key = JSON.stringify({ theme, level });
  if (cache.has(key)) return cache.get(key)!;

  const buildPairs = (nextTheme: any) => ([
    {
      name: "Text on background",
      fg: nextTheme.text,
      bg: nextTheme.background,
      ratio: contrastRatio(nextTheme.text, nextTheme.background),
      passAA: contrastRatio(nextTheme.text, nextTheme.background) >= 4.5,
      passAAA: contrastRatio(nextTheme.text, nextTheme.background) >= 7
    },
    {
      name: "Text on surface",
      fg: nextTheme.text,
      bg: nextTheme.surface || nextTheme.panel,
      ratio: contrastRatio(nextTheme.text, nextTheme.surface || nextTheme.panel),
      passAA: contrastRatio(nextTheme.text, nextTheme.surface || nextTheme.panel) >= 4.5,
      passAAA: contrastRatio(nextTheme.text, nextTheme.surface || nextTheme.panel) >= 7
    },
    {
      name: "Muted text",
      fg: nextTheme.mutedText || nextTheme.text,
      bg: nextTheme.background,
      ratio: contrastRatio(nextTheme.mutedText || nextTheme.text, nextTheme.background),
      passAA: contrastRatio(nextTheme.mutedText || nextTheme.text, nextTheme.background) >= 3,
      passAAA: contrastRatio(nextTheme.mutedText || nextTheme.text, nextTheme.background) >= 4.5
    },
    {
      name: "Accent button",
      fg: nextTheme.buttonText,
      bg: nextTheme.accent,
      ratio: contrastRatio(nextTheme.buttonText, nextTheme.accent),
      passAA: contrastRatio(nextTheme.buttonText, nextTheme.accent) >= 4.5,
      passAAA: contrastRatio(nextTheme.buttonText, nextTheme.accent) >= 7
    },
    {
      name: "Switch track (off)",
      fg: nextTheme.switchOff,
      bg: nextTheme.background,
      ratio: contrastRatio(nextTheme.switchOff, nextTheme.background),
      passAA: contrastRatio(nextTheme.switchOff, nextTheme.background) >= 3,
      passAAA: contrastRatio(nextTheme.switchOff, nextTheme.background) >= 4.5
    },
    {
      name: "Switch track (on)",
      fg: nextTheme.switchOn,
      bg: nextTheme.background,
      ratio: contrastRatio(nextTheme.switchOn, nextTheme.background),
      passAA: contrastRatio(nextTheme.switchOn, nextTheme.background) >= 3,
      passAAA: contrastRatio(nextTheme.switchOn, nextTheme.background) >= 4.5
    },
    {
      name: "Switch thumb",
      fg: nextTheme.switchThumb,
      bg: nextTheme.switchOn,
      ratio: contrastRatio(nextTheme.switchThumb, nextTheme.switchOn),
      passAA: contrastRatio(nextTheme.switchThumb, nextTheme.switchOn) >= 3,
      passAAA: contrastRatio(nextTheme.switchThumb, nextTheme.switchOn) >= 4.5
    },
    {
      name: "Slider track",
      fg: nextTheme.sliderTrack,
      bg: nextTheme.background,
      ratio: contrastRatio(nextTheme.sliderTrack, nextTheme.background),
      passAA: contrastRatio(nextTheme.sliderTrack, nextTheme.background) >= 3,
      passAAA: contrastRatio(nextTheme.sliderTrack, nextTheme.background) >= 4.5
    }
  ]);

  if (level === "off") {
    const fallbackButtonText = contrastRatio("#000000", theme.accent) >= contrastRatio("#FFFFFF", theme.accent)
      ? "#000000"
      : "#FFFFFF";
    const nextTheme = {
      ...theme,
      buttonText: fallbackButtonText,
      switchOn: theme.accent,
      switchOff: theme.surface || theme.panel,
      switchThumb: fallbackButtonText,
      sliderTrack: theme.accent,
      sliderThumb: fallbackButtonText
    };
    const report: ContrastReport = { level, pairs: buildPairs(nextTheme), adjusted: false };
    const result = { theme: nextTheme, report };
    cache.set(key, result);
    return result;
  }

  const target = level === "aaa" ? 7 : 4.5;
  const mutedTarget = 3;

  let adjusted = false;
  const nextTheme = { ...theme };

  const textAdjusted = adjustForContrast(nextTheme.text, nextTheme.background, target);
  if (textAdjusted !== nextTheme.text) {
    nextTheme.text = textAdjusted;
    adjusted = true;
  }

  const surfaceTextAdjusted = adjustForContrast(nextTheme.text, nextTheme.surface || nextTheme.panel, target);
  if (surfaceTextAdjusted !== nextTheme.text) {
    nextTheme.text = surfaceTextAdjusted;
    adjusted = true;
  }

  const mutedAdjusted = adjustForContrast(nextTheme.mutedText || nextTheme.text, nextTheme.background, mutedTarget);
  if (mutedAdjusted !== nextTheme.mutedText) {
    nextTheme.mutedText = mutedAdjusted;
    adjusted = true;
  }

  const accentText = contrastRatio("#000000", nextTheme.accent) >= contrastRatio("#FFFFFF", nextTheme.accent)
    ? "#000000"
    : "#FFFFFF";
  nextTheme.buttonText = adjustForContrast(accentText, nextTheme.accent, 4.5);

  const switchOffBase = nextTheme.surface || nextTheme.panel;
  const switchOnBase = nextTheme.accent;
  nextTheme.switchOff = adjustForContrast(switchOffBase, nextTheme.background, 3);
  nextTheme.switchOn = adjustForContrast(switchOnBase, nextTheme.background, 3);
  nextTheme.switchThumb = adjustForContrast(nextTheme.text, nextTheme.switchOn, 3);
  nextTheme.sliderTrack = adjustForContrast(nextTheme.accent, nextTheme.background, 3);
  nextTheme.sliderThumb = adjustForContrast(nextTheme.text, nextTheme.sliderTrack, 3);
  const pairs: ContrastPair[] = buildPairs(nextTheme);

  const report: ContrastReport = {
    level,
    pairs,
    adjusted,
    message: adjusted ? "Adjusted for visibility" : undefined
  };

  const result = { theme: nextTheme, report };
  cache.set(key, result);
  return result;
}

export function apcaEstimate(fg: string, bg: string) {
  const Ltxt = relativeLuminance(fg);
  const Lbg = relativeLuminance(bg);
  const polarity = Lbg > Ltxt ? 1 : -1;
  const diff = Math.abs(Lbg - Ltxt);
  const estimate = Math.round(diff * 120 * polarity);
  return estimate;
}
