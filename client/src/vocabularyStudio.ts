export type VocabularyStudioType = "words" | "sentences" | "fiction" | "code";

type EntryIssueCode = "blank" | "duplicate" | "too_long" | "invalid_chars";

export type EntryLineAnalysis = {
  index: number;
  raw: string;
  value: string;
  issues: EntryIssueCode[];
};

export type EntryAnalysis = {
  lines: EntryLineAnalysis[];
  cleanedLines: string[];
  uniqueLines: string[];
  emptyCount: number;
  duplicateCount: number;
  invalidCount: number;
  canPublish: boolean;
  wordsLengthBuckets: {
    short: number;
    medium: number;
    long: number;
  };
};

const DEFAULT_MAX_LENGTH: Record<VocabularyStudioType, number> = {
  words: 32,
  sentences: 180,
  fiction: 240,
  code: 320
};

function hasInvalidChars(line: string, type: VocabularyStudioType): boolean {
  if (!line) return false;
  if (type === "words") {
    if (/\s/.test(line)) return true;
    return /[^\p{L}\p{N}'’\-]/u.test(line);
  }
  if (type === "code") {
    return /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/u.test(line);
  }
  return /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/u.test(line);
}

export function analyzeVocabularyEntries(
  text: string,
  options: {
    type?: VocabularyStudioType;
    maxLength?: number;
  } = {}
): EntryAnalysis {
  const type = options.type || "words";
  const maxLength = Math.max(1, Number(options.maxLength || DEFAULT_MAX_LENGTH[type] || 120));
  const rawLines = String(text || "").replace(/\r\n/g, "\n").split("\n");
  const seen = new Set<string>();

  let emptyCount = 0;
  let duplicateCount = 0;
  let invalidCount = 0;

  const lines: EntryLineAnalysis[] = rawLines.map((raw, index) => {
    const value = raw.trim();
    const issues: EntryIssueCode[] = [];
    if (!value) {
      issues.push("blank");
      emptyCount += 1;
    } else {
      const key = value.toLocaleLowerCase();
      if (seen.has(key)) {
        issues.push("duplicate");
        duplicateCount += 1;
      } else {
        seen.add(key);
      }
      if (value.length > maxLength) {
        issues.push("too_long");
        invalidCount += 1;
      }
      if (hasInvalidChars(value, type)) {
        issues.push("invalid_chars");
        invalidCount += 1;
      }
    }
    return { index, raw, value, issues };
  });

  const cleanedLines = lines.filter((line) => line.value).map((line) => line.value);
  const uniqueMap = new Set<string>();
  const uniqueLines = cleanedLines.filter((line) => {
    const key = line.toLocaleLowerCase();
    if (uniqueMap.has(key)) return false;
    uniqueMap.add(key);
    return true;
  });

  const wordsLengthBuckets = cleanedLines.reduce((acc, value) => {
    if (type !== "words") return acc;
    if (value.length <= 4) acc.short += 1;
    else if (value.length <= 8) acc.medium += 1;
    else acc.long += 1;
    return acc;
  }, { short: 0, medium: 0, long: 0 });

  return {
    lines,
    cleanedLines,
    uniqueLines,
    emptyCount,
    duplicateCount,
    invalidCount,
    canPublish: cleanedLines.length > 0 && invalidCount === 0,
    wordsLengthBuckets
  };
}

export function replaceEntryLines(text: string, lines: string[]): string {
  const normalized = lines.map((line) => String(line || "").trim()).filter(Boolean);
  return normalized.join("\n");
}

export function dedupeEntryLines(text: string): string {
  const analysis = analyzeVocabularyEntries(text);
  return replaceEntryLines(text, analysis.uniqueLines);
}

export function sortEntryLines(text: string): string {
  const analysis = analyzeVocabularyEntries(text);
  return replaceEntryLines(text, [...analysis.cleanedLines].sort((a, b) => a.localeCompare(b)));
}

export function normalizeEntryCase(text: string, mode: "lower" | "upper"): string {
  const analysis = analyzeVocabularyEntries(text);
  const mapped = analysis.cleanedLines.map((line) => (mode === "lower" ? line.toLocaleLowerCase() : line.toLocaleUpperCase()));
  return replaceEntryLines(text, mapped);
}

type ImportPreview = {
  name: string;
  language: string;
  level: number;
  type: VocabularyStudioType;
  status: string;
  entryCount: number;
};

export function parseVocabularyImportInput(
  source: string,
  options: { importAsDraft?: boolean } = {}
): {
  ok: true;
  payload: { pack: any; entries: any[] };
  preview: ImportPreview;
} | {
  ok: false;
  errors: string[];
} {
  const errors: string[] = [];
  let parsed: any = null;
  try {
    parsed = JSON.parse(source || "{}");
  } catch {
    return { ok: false, errors: ["JSON is invalid."] };
  }
  const root = parsed?.payload && typeof parsed.payload === "object" ? parsed.payload : parsed;
  if (!root || typeof root !== "object") return { ok: false, errors: ["Import payload must be an object."] };

  const pack = root.pack;
  const entries = Array.isArray(root.entries) ? root.entries : [];
  if (!pack || typeof pack !== "object") errors.push("Missing `pack` object.");
  if (!Array.isArray(root.entries)) errors.push("Missing `entries` array.");

  const name = String(pack?.name || "").trim();
  const language = String(pack?.language || "").trim().toLowerCase();
  const level = Number(pack?.level || 0);
  const type = String(pack?.type || "") as VocabularyStudioType;
  const status = String(pack?.status || "draft");

  if (!name) errors.push("Pack name is required.");
  if (!language) errors.push("Pack language is required.");
  if (!Number.isFinite(level) || level < 1 || level > 5) errors.push("Pack level must be between 1 and 5.");
  if (!["words", "sentences", "fiction", "code"].includes(type)) errors.push("Pack type must be words/sentences/fiction/code.");

  const normalizedEntries = entries
    .map((entry: any) => ({ ...entry, text: String(entry?.text || "").trim() }))
    .filter((entry: any) => entry.text);
  if (normalizedEntries.length === 0) errors.push("At least one entry is required.");

  if (errors.length > 0) return { ok: false, errors };

  const normalizedPack = {
    ...pack,
    name,
    language,
    level,
    type,
    status: options.importAsDraft ? "draft" : status || "draft"
  };
  return {
    ok: true,
    payload: { pack: normalizedPack, entries: normalizedEntries },
    preview: {
      name: normalizedPack.name,
      language: normalizedPack.language,
      level: normalizedPack.level,
      type: normalizedPack.type,
      status: normalizedPack.status,
      entryCount: normalizedEntries.length
    }
  };
}
