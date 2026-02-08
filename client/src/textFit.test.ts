import { describe, it, expect } from "vitest";
import { computeFit } from "./textFit";

const measure = (textLength: number) => (fontSize: number) => ({
  width: fontSize * textLength * 0.6,
  height: fontSize * 1.1
});

describe("computeFit", () => {
  it("fits text within container bounds", () => {
    const result = computeFit(measure(8), { width: 400, height: 200 }, {
      scale: 1,
      min: 40,
      max: 300,
      lineHeight: 1.1,
      letterSpacing: 0.05,
      allowWrap: false
    });
    expect(result.fontSize).toBeGreaterThan(40);
    expect(result.width).toBeLessThanOrEqual(400);
    expect(result.height).toBeLessThanOrEqual(200);
  });

  it("respects min/max range", () => {
    const result = computeFit(measure(1), { width: 80, height: 80 }, {
      scale: 1,
      min: 50,
      max: 120,
      lineHeight: 1.1,
      letterSpacing: 0.05,
      allowWrap: false
    });
    expect(result.fontSize).toBeGreaterThanOrEqual(50);
    expect(result.fontSize).toBeLessThanOrEqual(120);
  });
});
