const fs = require("fs");
const path = require("path");

const RUNTIME_CONFIG_PATH = process.env.DB_RUNTIME_CONFIG_PATH || "/data/runtime-db.json";

function ensureDir(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function readRuntimeConfig() {
  try {
    const raw = fs.readFileSync(RUNTIME_CONFIG_PATH, "utf8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function writeRuntimeConfig(next) {
  ensureDir(RUNTIME_CONFIG_PATH);
  fs.writeFileSync(RUNTIME_CONFIG_PATH, JSON.stringify(next, null, 2));
}

module.exports = {
  RUNTIME_CONFIG_PATH,
  readRuntimeConfig,
  writeRuntimeConfig
};
