const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
const digits = "0123456789".split("");

const level2Words = [
  "cat", "dog", "sun", "hat", "cup", "pig", "pen", "car", "bee", "zip",
  "run", "sit", "hot", "red", "big", "toy", "top", "fox", "box", "jam",
  "hop", "bat", "bus", "egg", "ice", "yak", "owl", "ant", "bed", "mom"
];

const level3Words = [
  "apple", "banana", "rabbit", "monkey", "yellow", "purple", "rocket", "garden",
  "little", "bubble", "cookie", "kitten", "puppy", "castle", "dragon", "flower",
  "giraffe", "pillow", "turtle", "camera", "planet", "winter", "summer", "spring",
  "bridge", "school", "friend", "window", "orange", "balloon"
];

const sentenceWords = [
  "the", "a", "big", "small", "red", "blue", "happy", "fast", "slow", "sun",
  "moon", "star", "dog", "cat", "bird", "fish", "ball", "tree", "car", "hat",
  "runs", "jumps", "eats", "plays", "likes", "finds", "with", "and", "in", "on"
];

const sentenceTemplates = [
  ["the", "red", "ball"],
  ["a", "happy", "dog"],
  ["the", "cat", "jumps"],
  ["the", "blue", "bird"],
  ["a", "small", "fish"],
  ["the", "dog", "runs"],
  ["the", "sun", "is", "big"],
  ["the", "moon", "is", "bright"],
  ["a", "happy", "cat", "plays"],
  ["the", "red", "car", "goes", "fast"]
];

module.exports = {
  letters,
  digits,
  level2Words,
  level3Words,
  sentenceWords,
  sentenceTemplates
};
