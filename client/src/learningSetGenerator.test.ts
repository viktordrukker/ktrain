import { describe, expect, it } from "vitest";
import { createDefaultLearningSetConfig } from "./learningSetPlanner";
import { generateLearningSet, parseLearningSetImportInput, validateLearningSetSchema } from "./learningSetGenerator";

describe("learningSetGenerator", () => {
  it("produces deterministic output for same seed", () => {
    const config = createDefaultLearningSetConfig();
    config.name = "Animals EN Set";
    config.seed = "stable-seed";
    config.language = "en";
    config.topic = "animals";
    const a = generateLearningSet(config);
    const b = generateLearningSet(config);
    expect(a.packs[0].entries).toEqual(b.packs[0].entries);
    expect(a.packs.map((pack) => pack.name)).toEqual(b.packs.map((pack) => pack.name));
  });

  it("enforces script constraints for cyrillic", () => {
    const config = createDefaultLearningSetConfig();
    config.name = "RU Set";
    config.language = "ru";
    config.script = "cyrillic";
    config.topic = "animals";
    const generated = generateLearningSet(config);
    const allEntries = generated.packs.flatMap((pack) => pack.entries);
    expect(allEntries.every((entry) => /^[\p{Script=Cyrillic}\s'’\-.,!?]+$/u.test(entry))).toBe(true);
  });

  it("follows level length progression", () => {
    const config = createDefaultLearningSetConfig();
    config.name = "EN progression";
    config.language = "en";
    config.topic = "food";
    const generated = generateLearningSet(config);
    const l1 = generated.packs.find((pack) => pack.level === 1)!;
    const l4 = generated.packs.find((pack) => pack.level === 4)!;
    const avg = (values: string[]) => values.reduce((sum, v) => sum + v.length, 0) / Math.max(1, values.length);
    expect(avg(l4.entries)).toBeGreaterThan(avg(l1.entries));
  });

  it("schema validator reports malformed payloads", () => {
    const errors = validateLearningSetSchema({ kind: "wrong", schemaVersion: "0" });
    expect(errors.length).toBeGreaterThan(0);
  });

  it("parses a generated learning set payload for import preview", () => {
    const config = createDefaultLearningSetConfig();
    config.name = "Animals EN Set";
    const generated = generateLearningSet(config);
    const parsed = parseLearningSetImportInput(JSON.stringify(generated));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.preview.packs).toBe(generated.packs.length);
    expect(parsed.preview.levels).toEqual([1, 2, 3, 4, 5]);
  });
});
