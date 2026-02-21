import { describe, expect, it } from "vitest";
import {
  canUseSplitMode,
  computeVocabularyGridTemplate,
  resolveWorkspaceMode
} from "./vocabLayout";

describe("vocabLayout mode logic", () => {
  it("disables split mode on narrow viewports", () => {
    expect(canUseSplitMode(1100, false)).toBe(false);
    expect(resolveWorkspaceMode("split", 1100, false)).toBe("studio");
  });

  it("keeps split mode on wide desktop viewports", () => {
    expect(canUseSplitMode(1440, false)).toBe(true);
    expect(resolveWorkspaceMode("split", 1440, false)).toBe("split");
  });

  it("returns no grid template for mobile", () => {
    expect(computeVocabularyGridTemplate({
      mode: "split",
      viewportWidth: 700,
      isMobile: true,
      leftPanePercent: 22,
      rightPanePercent: 33,
      inspectorMaximized: false
    })).toBeUndefined();
  });

  it("returns two-column template for studio mode", () => {
    const template = computeVocabularyGridTemplate({
      mode: "studio",
      viewportWidth: 1400,
      isMobile: false,
      leftPanePercent: 22,
      rightPanePercent: 33,
      inspectorMaximized: false
    });
    expect(template).toContain("minmax(240px, 22%)");
    expect(template).not.toContain("10px minmax(360px");
  });
});

