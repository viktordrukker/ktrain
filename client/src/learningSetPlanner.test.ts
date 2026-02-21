import { describe, expect, it } from "vitest";
import {
  buildLearningSetPreviewPlan,
  createDefaultLearningSetConfig,
  normalizeLearningSetLevels,
  validateLearningSetConfig
} from "./learningSetPlanner";

describe("learningSetPlanner", () => {
  it("normalizes selected levels into sorted unique values", () => {
    expect(normalizeLearningSetLevels([5, 2, 2, 1, 9, 0])).toEqual([1, 2, 5]);
  });

  it("validates required fields", () => {
    const config = createDefaultLearningSetConfig();
    config.name = "";
    config.levels = [];
    const errors = validateLearningSetConfig(config);
    expect(errors.length).toBeGreaterThan(0);
  });

  it("builds a stable plan by level with sample entries", () => {
    const config = createDefaultLearningSetConfig();
    config.name = "Animals EN Set";
    config.language = "en";
    config.topic = "animals";
    const plan = buildLearningSetPreviewPlan(config);
    expect(plan.countsByLevel[1]).toBeGreaterThan(0);
    expect(plan.sampleByLevel[1].length).toBe(3);
  });
});

