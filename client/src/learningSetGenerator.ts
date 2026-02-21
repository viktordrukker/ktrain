import {
  buildLearningSetPreviewPlan,
  normalizeLearningSetLevels,
  type LearningSetLevelType,
  type LearningSetScript,
  type LearningSetTopic,
  type LearningSetWizardConfig
} from "./learningSetPlanner";

type GenerationReport = {
  removedBlank: number;
  removedDuplicate: number;
  removedInvalidChar: number;
  removedLength: number;
};

export type GeneratedLearningPack = {
  name: string;
  language: string;
  level: number;
  type: LearningSetLevelType;
  status: "draft" | "published";
  entries: string[];
  meta: {
    notes: string;
    tags: string[];
  };
};

export type GeneratedLearningSet = {
  schemaVersion: "1.0";
  kind: "ktrain.learningSet";
  set: {
    name: string;
    language: string;
    topic: LearningSetTopic;
    script: LearningSetScript;
    seed: string;
    constraints: {
      allowedChars: string;
      disallowedChars: string;
      includeDiacritics: boolean;
    };
    levels: number[];
    generatedAt: string;
  };
  packs: GeneratedLearningPack[];
  report: Record<number, GenerationReport>;
};

export type LearningSetPackCreatePayload = {
  name: string;
  language: string;
  level: number;
  type: LearningSetLevelType;
  status: "draft" | "published";
  source: "manual";
  metadata: any;
  entries: Array<{ text: string; order_index: number }>;
};

export type LearningSetImportPreview = {
  name: string;
  language: string;
  topic: string;
  script: string;
  levels: number[];
  packs: number;
  entries: number;
};

const BASE_WORDS: Record<string, Record<LearningSetTopic, string[]>> = {
  en: {
    animals: ["cat", "dog", "hen", "duck", "otter", "rabbit", "tiger", "falcon", "giraffe", "dolphin", "hamster", "sparrow", "turtle", "leopard"],
    food: ["apple", "bread", "honey", "grapes", "carrot", "cheese", "tomato", "pepper", "banana", "noodle", "cereal", "pumpkin", "coconut"],
    colors: ["red", "blue", "green", "black", "white", "purple", "yellow", "orange", "silver", "violet", "emerald", "indigo"],
    alphabet: ["alpha", "beta", "gamma", "delta", "theta", "lambda", "sigma", "omega"],
    phonics: ["tap", "sun", "ship", "light", "stone", "garden", "bridge", "thunder", "school"],
    custom: ["focus", "typing", "rhythm", "lesson", "repeat", "smooth", "steady", "timing"]
  },
  ru: {
    animals: ["кот", "пес", "лиса", "утка", "кролик", "тигр", "дельфин", "черепаха", "воробей", "леопард"],
    food: ["хлеб", "суп", "каша", "сыр", "яблоко", "морковь", "помидор", "банан", "перец", "творог"],
    colors: ["красный", "синий", "зелёный", "белый", "чёрный", "жёлтый", "фиолетовый", "оранжевый"],
    alphabet: ["аз", "буки", "веди", "глаголь", "добро", "земля"],
    phonics: ["дом", "луг", "река", "свет", "школа", "трава", "звезда"],
    custom: ["урок", "навык", "ритм", "темп", "точность", "практика"]
  },
  uz: {
    animals: ["mushuk", "it", "quyon", "ot", "bo‘ri", "qarg‘a", "tovuq", "delfin"],
    food: ["non", "sho‘rva", "olma", "sabzi", "pishloq", "banan", "qatiq", "guruch"],
    colors: ["qizil", "ko‘k", "yashil", "oq", "qora", "sariq", "to‘q"],
    alphabet: ["alifbo", "harf", "bo‘g‘in", "tovush", "soz"],
    phonics: ["bola", "qush", "daraxt", "yo‘l", "daryo", "shamol"],
    custom: ["mashq", "tezlik", "aniqlik", "ritm", "takror"]
  }
};

function hashSeed(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function makeRng(seed: string): () => number {
  let state = hashSeed(seed || "ktrain");
  return () => {
    state = Math.imul(state ^ (state >>> 15), 1 | state);
    state ^= state + Math.imul(state ^ (state >>> 7), 61 | state);
    return ((state ^ (state >>> 14)) >>> 0) / 4294967296;
  };
}

function levelRange(level: number, type: LearningSetLevelType): { min: number; max: number } {
  if (type === "sentences") {
    if (level <= 3) return { min: 10, max: 48 };
    if (level === 4) return { min: 14, max: 64 };
    return { min: 16, max: 88 };
  }
  if (level <= 1) return { min: 3, max: 4 };
  if (level === 2) return { min: 4, max: 5 };
  if (level === 3) return { min: 5, max: 7 };
  if (level === 4) return { min: 7, max: 10 };
  return { min: 6, max: 12 };
}

function scriptRegex(script: LearningSetScript, includeDiacritics: boolean): RegExp {
  if (script === "cyrillic") return /^[\p{Script=Cyrillic}\s'’\-.,!?]+$/u;
  if (script === "latin") {
    return includeDiacritics
      ? /^[\p{Script=Latin}\s'’\-.,!?]+$/u
      : /^[a-zA-Z\s'’\-.,!?]+$/;
  }
  return /^.+$/;
}

function enforceCustomAlphabet(token: string, alphabet: string): boolean {
  const chars = new Set([...alphabet.toLowerCase()]);
  for (const ch of token.toLowerCase()) {
    if (/\s/.test(ch)) continue;
    if (!chars.has(ch)) return false;
  }
  return true;
}

function sanitizeEntry(
  input: string,
  options: {
    script: LearningSetScript;
    includeDiacritics: boolean;
    customAlphabet: string;
    allowedChars: string;
    disallowedChars: string;
    minLen: number;
    maxLen: number;
  },
  report: GenerationReport
): string | null {
  const text = String(input || "").trim().replace(/\s+/g, " ");
  if (!text) {
    report.removedBlank += 1;
    return null;
  }
  if (text.length < options.minLen || text.length > options.maxLen) {
    report.removedLength += 1;
    return null;
  }
  const reg = scriptRegex(options.script, options.includeDiacritics);
  if (!reg.test(text)) {
    report.removedInvalidChar += 1;
    return null;
  }
  if (options.script === "custom" && !enforceCustomAlphabet(text, options.customAlphabet || "")) {
    report.removedInvalidChar += 1;
    return null;
  }
  if (options.allowedChars) {
    const allowed = new Set([...options.allowedChars.toLowerCase()]);
    const bad = [...text.toLowerCase()].find((ch) => !/\s|[.,!?'"’\-]/.test(ch) && !allowed.has(ch));
    if (bad) {
      report.removedInvalidChar += 1;
      return null;
    }
  }
  if (options.disallowedChars) {
    const disallowed = new Set([...options.disallowedChars.toLowerCase()]);
    const bad = [...text.toLowerCase()].find((ch) => disallowed.has(ch));
    if (bad) {
      report.removedInvalidChar += 1;
      return null;
    }
  }
  return text;
}

function sentenceFromWords(a: string, b: string, c: string): string {
  const first = a.charAt(0).toUpperCase() + a.slice(1);
  return `${first} ${b} ${c}.`;
}

function pickWordPool(language: string, topic: LearningSetTopic): string[] {
  const bank = BASE_WORDS[String(language || "en").toLowerCase()] || BASE_WORDS.en;
  return (bank[topic] || bank.custom || BASE_WORDS.en.custom).slice();
}

export function generateLearningSet(config: LearningSetWizardConfig): GeneratedLearningSet {
  const levels = normalizeLearningSetLevels(config.levels);
  const seed = String(config.seed || `${config.language}-${config.topic}-${levels.join("-")}`);
  const rng = makeRng(seed);
  const plan = buildLearningSetPreviewPlan(config);
  const packs: GeneratedLearningPack[] = [];
  const report: Record<number, GenerationReport> = {};
  const basePool = pickWordPool(config.language, config.topic);

  levels.forEach((level) => {
    const targetCount = Number(plan.countsByLevel[level] || 20);
    const type = (config.levelTypeOverrides[level] || "words") as LearningSetLevelType;
    const range = levelRange(level, type);
    const levelReport: GenerationReport = {
      removedBlank: 0,
      removedDuplicate: 0,
      removedInvalidChar: 0,
      removedLength: 0
    };

    const entries: string[] = [];
    const dedupe = new Set<string>();
    let safety = 0;
    while (entries.length < targetCount && safety < targetCount * 40) {
      safety += 1;
      const sourceA = basePool[Math.floor(rng() * basePool.length)] || "practice";
      const sourceB = basePool[Math.floor(rng() * basePool.length)] || "typing";
      const sourceC = basePool[Math.floor(rng() * basePool.length)] || "daily";
      let candidate = sourceA;
      if (type === "sentences") candidate = sentenceFromWords(sourceA, sourceB, sourceC);
      const sanitized = sanitizeEntry(candidate, {
        script: config.script,
        includeDiacritics: Boolean(config.includeDiacritics),
        customAlphabet: config.customAlphabet || "",
        allowedChars: config.allowedChars || "",
        disallowedChars: config.disallowedChars || "",
        minLen: range.min,
        maxLen: Math.min(range.max, Number(config.maxWordLengthByLevel[level] || range.max))
      }, levelReport);
      if (!sanitized) continue;
      const key = sanitized.toLocaleLowerCase();
      if (dedupe.has(key)) {
        levelReport.removedDuplicate += 1;
        continue;
      }
      dedupe.add(key);
      entries.push(sanitized);
    }

    packs.push({
      name: `${config.name || `${config.topic} set`} L${level}`,
      language: String(config.language || "en").toLowerCase(),
      level,
      type,
      status: config.autoPublish ? "published" : "draft",
      entries,
      meta: {
        notes: "Generated by Learning Set wizard",
        tags: [`topic:${config.topic}`, `script:${config.script}`, "generated:set"]
      }
    });
    report[level] = levelReport;
  });

  return {
    schemaVersion: "1.0",
    kind: "ktrain.learningSet",
    set: {
      name: config.name || `${config.topic} set`,
      language: String(config.language || "en").toUpperCase(),
      topic: config.topic,
      script: config.script,
      seed,
      constraints: {
        allowedChars: config.allowedChars || "",
        disallowedChars: config.disallowedChars || "",
        includeDiacritics: Boolean(config.includeDiacritics)
      },
      levels,
      generatedAt: new Date().toISOString()
    },
    packs,
    report
  };
}

export function validateLearningSetSchema(input: any): string[] {
  const errors: string[] = [];
  if (!input || typeof input !== "object") return ["Payload must be an object."];
  if (input.schemaVersion !== "1.0") errors.push("Unsupported schemaVersion.");
  if (input.kind !== "ktrain.learningSet") errors.push("Invalid kind.");
  if (!input.set || typeof input.set !== "object") errors.push("Missing set metadata.");
  if (!Array.isArray(input.packs) || input.packs.length === 0) errors.push("packs must be a non-empty array.");
  (input.packs || []).forEach((pack: any, idx: number) => {
    if (!pack || typeof pack !== "object") errors.push(`packs[${idx}] must be an object.`);
    if (!String(pack.name || "").trim()) errors.push(`packs[${idx}].name is required.`);
    if (!Number.isInteger(Number(pack.level)) || Number(pack.level) < 1 || Number(pack.level) > 5) errors.push(`packs[${idx}].level must be 1..5.`);
    if (!["words", "sentences"].includes(String(pack.type || ""))) errors.push(`packs[${idx}].type must be words/sentences.`);
    if (!Array.isArray(pack.entries)) errors.push(`packs[${idx}].entries must be an array.`);
  });
  return errors;
}

export function parseLearningSetImportInput(
  source: string
): {
  ok: true;
  payload: GeneratedLearningSet;
  preview: LearningSetImportPreview;
} | {
  ok: false;
  errors: string[];
} {
  let parsed: any = null;
  try {
    parsed = JSON.parse(source || "{}");
  } catch {
    return { ok: false, errors: ["JSON is invalid."] };
  }
  const root = parsed?.payload && typeof parsed.payload === "object" ? parsed.payload : parsed;
  if (!root || typeof root !== "object") return { ok: false, errors: ["Import payload must be an object."] };
  const errors = validateLearningSetSchema(root);
  if (errors.length > 0) return { ok: false, errors };
  const levels = normalizeLearningSetLevels(Array.isArray(root?.set?.levels) ? root.set.levels : []);
  const packs = Array.isArray(root.packs) ? root.packs : [];
  const entries = packs.reduce((sum, pack) => sum + (Array.isArray(pack?.entries) ? pack.entries.length : 0), 0);
  return {
    ok: true,
    payload: root as GeneratedLearningSet,
    preview: {
      name: String(root?.set?.name || "Learning Set"),
      language: String(root?.set?.language || "").toUpperCase(),
      topic: String(root?.set?.topic || "custom"),
      script: String(root?.set?.script || "latin"),
      levels,
      packs: packs.length,
      entries
    }
  };
}

export function buildLearningSetPackPayloads(
  generated: GeneratedLearningSet,
  options: { importAsDraft?: boolean; learningSetId?: string } = {}
): LearningSetPackCreatePayload[] {
  const setId = String(options.learningSetId || generated.set.seed || "learning-set");
  return generated.packs.map((pack) => ({
    name: pack.name,
    language: pack.language,
    level: Number(pack.level),
    type: pack.type,
    status: options.importAsDraft ? "draft" : pack.status,
    source: "manual",
    metadata: {
      ...pack.meta,
      learningSetId: setId,
      learningSet: generated.set,
      learningSetSchemaVersion: generated.schemaVersion,
      learningSetKind: generated.kind,
      learningSetReport: generated.report[pack.level] || null
    },
    entries: (pack.entries || []).map((text, idx) => ({ text, order_index: idx }))
  }));
}
