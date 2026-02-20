import { describe, expect, it } from "vitest";
import { resolveAntiSmashRuntimeConfig } from "./antiSmashRuntime";

describe("resolveAntiSmashRuntimeConfig", () => {
  it("enables anti-smash on level 1 by default", () => {
    const cfg = resolveAntiSmashRuntimeConfig({ enabled: true }, false, 1);
    expect(cfg.enabled).toBe(true);
  });

  it("does not enable anti-smash on higher levels unless toddler mode is on", () => {
    const regular = resolveAntiSmashRuntimeConfig({ enabled: true }, false, 5);
    const toddler = resolveAntiSmashRuntimeConfig({ enabled: true }, true, 5);
    expect(regular.enabled).toBe(false);
    expect(toddler.enabled).toBe(true);
  });

  it("respects explicit disable flag", () => {
    const disabled = resolveAntiSmashRuntimeConfig({ enabled: false }, true, 1);
    expect(disabled.enabled).toBe(false);
  });
});
