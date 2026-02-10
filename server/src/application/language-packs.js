const BUILTIN_PACKS = [
  {
    language: "en",
    type: "level2",
    topic: "default",
    items: ["a", "at", "cat", "sun", "dog", "red", "run", "mom", "dad", "toy"]
  },
  {
    language: "en",
    type: "level3",
    topic: "default",
    items: ["apple", "garden", "rabbit", "yellow", "banana", "window", "forest", "turtle", "happy", "school"]
  },
  {
    language: "en",
    type: "sentence_words",
    topic: "default",
    items: ["the", "dog", "is", "big", "cat", "runs", "my", "mom", "likes", "sun"]
  },
  {
    language: "ru",
    type: "level2",
    topic: "default",
    items: ["дом", "кот", "мяч", "мир", "сад", "нос", "лес", "еда", "сон", "дед"]
  },
  {
    language: "ru",
    type: "level3",
    topic: "default",
    items: ["машина", "яблоко", "дружба", "школа", "солнышко", "дерево", "книга", "красивый", "улыбка", "семья"]
  },
  {
    language: "ru",
    type: "sentence_words",
    topic: "default",
    items: ["я", "люблю", "маму", "кот", "идет", "в", "сад", "мы", "играем", "дома"]
  }
];

function strictPrompt({ language, type, count, topic }) {
  const typeRules = {
    level2: "1-3 characters/letters per item",
    level3: "3-8 characters/letters per item",
    sentence_words: "simple toddler-safe sentence building words"
  };
  return [
    "You are a children's educational content generator.",
    "Output STRICT JSON only with schema: {\"items\": [\"...\"]}.",
    "Rules:",
    "- Child-safe language only.",
    "- No violence, abuse, hate, sexual, political, or sensitive content.",
    "- No profanity.",
    `- Language: ${language}.`,
    `- Type constraints: ${typeRules[type] || typeRules.level2}.`,
    `- Topic: ${topic || "general toddler vocabulary"}.`,
    `- Generate exactly ${count} unique items.`,
    "- Do not include punctuation except language-native letters and spaces.",
    "- Return only JSON."
  ].join("\n");
}

async function seedBuiltinLanguagePacks(repo) {
  const current = await repo.listLanguagePacks({});
  if (current.length > 0) return;
  for (const pack of BUILTIN_PACKS) {
    const packId = await repo.createLanguagePack({
      language: pack.language,
      type: pack.type,
      topic: pack.topic,
      status: "PUBLISHED",
      createdBy: null
    });
    await repo.replaceLanguagePackItems(
      packId,
      pack.items.map((text) => ({ text, difficulty: null, metadataJson: { builtin: true } }))
    );
  }
}

module.exports = {
  BUILTIN_PACKS,
  strictPrompt,
  seedBuiltinLanguagePacks
};
