import { describe, expect, it } from "vitest";
import {
  analyzeVocabularyEntries,
  dedupeEntryLines,
  normalizeEntryCase,
  parseVocabularyImportInput,
  sortEntryLines
} from "./vocabularyStudio";

describe("vocabularyStudio entry analysis", () => {
  it("counts blanks, duplicates, invalid chars, and publish readiness", () => {
    const analysis = analyzeVocabularyEntries("cat\n \ncat\nbad word\nDOG", { type: "words", maxLength: 10 });
    expect(analysis.emptyCount).toBe(1);
    expect(analysis.duplicateCount).toBe(1);
    expect(analysis.invalidCount).toBeGreaterThan(0);
    expect(analysis.canPublish).toBe(false);
  });

  it("provides cleanup helpers", () => {
    expect(dedupeEntryLines("b\nA\nb\n")).toBe("b\nA");
    expect(sortEntryLines("b\na\nc")).toBe("a\nb\nc");
    expect(normalizeEntryCase("Cat\nDOG", "lower")).toBe("cat\ndog");
  });
});

describe("vocabularyStudio import parsing", () => {
  it("returns preview and normalized payload for valid import JSON", () => {
    const result = parseVocabularyImportInput(JSON.stringify({
      payload: {
        pack: { name: "Animals", language: "EN", level: 1, type: "words", status: "published" },
        entries: [{ text: "cat" }, { text: "dog" }]
      }
    }), { importAsDraft: true });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.preview.entryCount).toBe(2);
    expect(result.payload.pack.status).toBe("draft");
    expect(result.payload.pack.language).toBe("en");
  });

  it("returns user-facing validation errors for invalid schema", () => {
    const result = parseVocabularyImportInput("{\"pack\":{}}");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.length).toBeGreaterThan(0);
  });
});
