export type LearningSetTopic =
  | "animals"
  | "food"
  | "colors"
  | "alphabet"
  | "phonics"
  | "custom";

export type LearningSetScript = "latin" | "cyrillic" | "custom";

export type LearningSetLevelType = "words" | "sentences";

export type LearningSetWizardConfig = {
  name: string;
  language: string;
  topic: LearningSetTopic;
  script: LearningSetScript;
  levels: number[];
  customAlphabet: string;
  allowedChars: string;
  disallowedChars: string;
  includeDiacritics: boolean;
  maxWordLengthByLevel: Record<number, number>;
  levelTypeOverrides: Partial<Record<number, LearningSetLevelType>>;
  seed: string;
  autoPublish: boolean;
};

export type LearningSetPlan = {
  countsByLevel: Record<number, number>;
  sampleByLevel: Record<number, string[]>;
};

const DEFAULT_COUNTS: Record<number, number> = {
  1: 20,
  2: 25,
  3: 25,
  4: 30,
  5: 15
};

const SAMPLE_BANK: Record<string, Record<LearningSetTopic, string[]>> = {
  en: {
    animals: ["cat", "dog", "hen", "rabbit", "turtle", "dolphin"],
    food: ["apple", "bread", "soup", "pasta", "carrot", "cheese"],
    colors: ["red", "blue", "green", "yellow", "purple", "orange"],
    alphabet: ["alpha", "beta", "gamma", "delta", "epsilon"],
    phonics: ["tap", "sun", "ship", "light", "train", "cloud"],
    custom: ["learn", "focus", "practice", "typing", "rhythm"]
  },
  ru: {
    animals: ["кот", "пес", "лиса", "заяц", "черепаха", "дельфин"],
    food: ["хлеб", "суп", "каша", "яблоко", "сыр", "морковь"],
    colors: ["красный", "синий", "зелёный", "жёлтый", "фиолетовый"],
    alphabet: ["аз", "буки", "веди", "глаголь"],
    phonics: ["дом", "мир", "свет", "река", "луг"],
    custom: ["урок", "практика", "ритм", "набор", "клавиши"]
  }
};

export function createDefaultLearningSetConfig(): LearningSetWizardConfig {
  return {
    name: "",
    language: "en",
    topic: "animals",
    script: "latin",
    levels: [1, 2, 3, 4, 5],
    customAlphabet: "",
    allowedChars: "",
    disallowedChars: "",
    includeDiacritics: false,
    maxWordLengthByLevel: {
      1: 1,
      2: 5,
      3: 7,
      4: 10,
      5: 18
    },
    levelTypeOverrides: {
      1: "words",
      2: "words",
      3: "words",
      4: "words",
      5: "sentences"
    },
    seed: "",
    autoPublish: false
  };
}

export function normalizeLearningSetLevels(levels: number[]): number[] {
  const unique = new Set<number>();
  (levels || []).forEach((level) => {
    const safe = Number(level);
    if (Number.isInteger(safe) && safe >= 1 && safe <= 5) unique.add(safe);
  });
  return [...unique].sort((a, b) => a - b);
}

export function validateLearningSetConfig(config: LearningSetWizardConfig): string[] {
  const errors: string[] = [];
  if (!String(config.name || "").trim()) errors.push("Set name is required.");
  if (!String(config.language || "").trim()) errors.push("Language is required.");
  const levels = normalizeLearningSetLevels(config.levels);
  if (levels.length === 0) errors.push("Select at least one level.");
  if (config.script === "custom" && !String(config.customAlphabet || "").trim()) {
    errors.push("Custom alphabet is required when script is custom.");
  }
  return errors;
}

function pickSamples(language: string, topic: LearningSetTopic): string[] {
  const lang = String(language || "en").toLowerCase();
  const bank = SAMPLE_BANK[lang] || SAMPLE_BANK.en;
  return bank[topic] || SAMPLE_BANK.en.custom;
}

export function buildLearningSetPreviewPlan(config: LearningSetWizardConfig): LearningSetPlan {
  const levels = normalizeLearningSetLevels(config.levels);
  const samples = pickSamples(config.language, config.topic);
  const countsByLevel: Record<number, number> = {};
  const sampleByLevel: Record<number, string[]> = {};
  levels.forEach((level) => {
    const count = DEFAULT_COUNTS[level] || 20;
    countsByLevel[level] = count;
    if (level === 1 && (config.levelTypeOverrides[level] || "words") === "words") {
      sampleByLevel[level] = ["a", "s", "d"];
      return;
    }
    sampleByLevel[level] = samples.slice(0, 3).map((item, idx) => {
      if ((config.levelTypeOverrides[level] || "words") === "sentences") {
        return `${item[0]?.toUpperCase() || "A"}${item.slice(1)} is sample ${idx + 1}.`;
      }
      return item;
    });
  });
  return { countsByLevel, sampleByLevel };
}
