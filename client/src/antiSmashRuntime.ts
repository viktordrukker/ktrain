import { DEFAULT_ANTI_SMASH_CONFIG, type AntiSmashConfig } from "./inputController";

export function resolveAntiSmashRuntimeConfig(
  antiSmash: Partial<AntiSmashConfig> | null | undefined,
  toddlerMode: boolean,
  level: number
): AntiSmashConfig {
  const merged = {
    ...DEFAULT_ANTI_SMASH_CONFIG,
    ...(antiSmash || {})
  };
  const levelIsToddler = Number(level) === 1;
  return {
    ...merged,
    enabled: Boolean(merged.enabled) && (Boolean(toddlerMode) || levelIsToddler)
  };
}
