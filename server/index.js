require("dotenv").config();

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { exec } = require("child_process");
const { promisify } = require("util");
const { initDb, createAdapter, resolveDriver, DB_DRIVER_ENV, resolveDbConfig, sanitizeDbConfig, testPostgresConfig } = require("./db");
const { loadSettings, saveSettings } = require("./settings");
const { readRuntimeConfig, writeRuntimeConfig, RUNTIME_CONFIG_PATH } = require("./db/runtime-config");
const defaults = require("./data/defaults");

const execAsync = promisify(exec);

const app = express();
let repo;
let activeDriver = resolveDriver();
let maintenanceMode = false;

const PORT = process.env.PORT || 3000;
const ADMIN_PIN = process.env.ADMIN_PIN || "change-me";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const AUTH_ADMIN_GROUPS = String(process.env.AUTH_ADMIN_GROUPS || "admins,ldap-admins").split(",").map((x) => x.trim()).filter(Boolean);
const AUTH_TRUST_PROXY = String(process.env.AUTH_TRUST_PROXY || "true") === "true";
const DB_SWITCH_RESTART_CMD = process.env.DB_SWITCH_RESTART_CMD || "";
const DB_SWITCH_POSTGRES_UP_CMD = process.env.DB_SWITCH_POSTGRES_UP_CMD || "";
const DB_SWITCH_DUMP_DIR = process.env.DB_SWITCH_DUMP_DIR || "/data/db-switch";
const DB_SWITCH_AUDIT_LOG = process.env.DB_SWITCH_AUDIT_LOG || "/data/db-switch/switch-audit.log";

if (AUTH_TRUST_PROXY) {
  app.set("trust proxy", true);
}

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json({ limit: "2mb" }));
app.disable("x-powered-by");

app.use((req, res, next) => {
  const requestId = req.headers["x-request-id"] || crypto.randomUUID();
  req.requestId = requestId;
  res.setHeader("x-request-id", requestId);
  const started = Date.now();
  res.on("finish", () => {
    const ms = Date.now() - started;
    console.log(`${new Date().toISOString()} request_id=${requestId} ip=${req.ip} method=${req.method} path=${req.path} status=${res.statusCode} duration_ms=${ms}`);
  });
  next();
});

function parseGroups(req) {
  const raw = req.headers["x-forwarded-groups"] || req.headers["x-auth-request-groups"] || "";
  return String(raw).split(/[;,]/).map((x) => x.trim()).filter(Boolean);
}

function isAdmin(req) {
  const pin = req.headers["x-admin-pin"];
  if (pin && pin === ADMIN_PIN) return true;
  const user = req.headers["x-forwarded-user"] || req.headers["x-auth-request-user"];
  if (!user) return false;
  const groups = parseGroups(req);
  return groups.some((group) => AUTH_ADMIN_GROUPS.includes(group));
}

function requireAdmin(req, res, next) {
  if (!isAdmin(req)) {
    return res.status(403).json({ error: "Admin role required" });
  }
  return next();
}

function requireNotMaintenance(req, res, next) {
  if (!maintenanceMode) return next();
  return res.status(503).json({ error: "Maintenance mode active. Try again shortly." });
}

function chooseRandom(list) {
  return list[Math.floor(Math.random() * list.length)];
}

function sanitizeList(items) {
  const profanity = ["badword", "swear", "curse", "hate", "kill", "sex"];
  const filtered = items
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item && !profanity.some((bad) => item.includes(bad)));
  return Array.from(new Set(filtered));
}

function filterWordsByType(words, packType) {
  return words.filter((word) => {
    if (!/^[a-z]+$/.test(word)) return false;
    if (packType === "level2") return word.length >= 1 && word.length <= 3;
    if (packType === "level3") return word.length >= 3 && word.length <= 7;
    return word.length >= 1 && word.length <= 10;
  });
}

function cleanName(name) {
  const trimmed = String(name || "").replace(/[^\w\s'-]/g, "").trim();
  return trimmed.slice(0, 24) || "Player";
}

function clampNumber(value, min, max, fallback = 0) {
  const num = Number(value);
  if (Number.isNaN(num)) return fallback;
  return Math.min(Math.max(num, min), max);
}

function createRateLimiter({ windowMs, max }) {
  const hits = new Map();
  return (req, res, next) => {
    const now = Date.now();
    const key = req.ip || "unknown";
    const entry = hits.get(key) || { count: 0, resetAt: now + windowMs };
    if (now > entry.resetAt) {
      entry.count = 0;
      entry.resetAt = now + windowMs;
    }
    entry.count += 1;
    hits.set(key, entry);
    if (entry.count > max) {
      return res.status(429).json({ error: "Too many requests" });
    }
    return next();
  };
}

const adminLimiter = createRateLimiter({ windowMs: 60_000, max: 60 });
const resultsLimiter = createRateLimiter({ windowMs: 60_000, max: 90 });

async function getSetting(key) {
  return repo.getSetting(key);
}

async function setSetting(key, value) {
  await repo.setSetting(key, value);
}

async function getActivePack(type) {
  const row = await repo.getActivePack(type);
  if (!row) return null;
  return {
    ...row,
    items: typeof row.items === "string" ? JSON.parse(row.items) : row.items
  };
}

async function generateTasks(level, count, contentMode) {
  const tasks = [];

  const packLevel2 = contentMode === "vocab" ? await getActivePack("level2") : null;
  const packLevel3 = contentMode === "vocab" ? await getActivePack("level3") : null;
  const packSentence = contentMode === "vocab" ? await getActivePack("sentence_words") : null;

  const level2Words = packLevel2?.items?.length ? packLevel2.items : defaults.level2Words;
  const level3Words = packLevel3?.items?.length ? packLevel3.items : defaults.level3Words;
  const sentenceWords = packSentence?.items?.length ? packSentence.items : defaults.sentenceWords;

  if (level === 1) {
    for (let i = 0; i < count; i++) {
      const pool = [...defaults.letters, ...defaults.digits];
      const letter = chooseRandom(pool);
      tasks.push({ id: `${level}-c-${Date.now()}-${i}`, level, prompt: letter, answer: letter });
    }
  }

  if (level === 2) {
    for (let i = 0; i < count; i++) {
      const word = chooseRandom(level2Words);
      tasks.push({ id: `${level}-w-${Date.now()}-${i}`, level, prompt: word, answer: word });
    }
  }

  if (level === 3) {
    for (let i = 0; i < count; i++) {
      const word = chooseRandom(level3Words);
      tasks.push({ id: `${level}-w-${Date.now()}-${i}`, level, prompt: word, answer: word });
    }
  }

  if (level === 4 || level === 5) {
    while (tasks.length < count) {
      const maxWords = level === 4 ? 3 : 9;
      const minWords = level === 4 ? 2 : 4;
      const length = Math.floor(Math.random() * (maxWords - minWords + 1)) + minWords;
      const words = Array.from({ length }, () => chooseRandom(sentenceWords));
      const sentence = words.join(" ");
      words.forEach((word, idx) => {
        tasks.push({
          id: `${level}-s-${Date.now()}-${tasks.length}`,
          level,
          prompt: word,
          answer: word,
          sentence,
          wordIndex: idx,
          words
        });
      });
    }
  }

  return tasks.slice(0, count);
}

async function callOpenAI({ apiKey, prompt }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`
    },
    signal: controller.signal,
    body: JSON.stringify({
      model: OPENAI_MODEL,
      input: prompt,
      temperature: 0.7
    })
  });
  clearTimeout(timeout);

  if (!response.ok) {
    const text = await response.text();
    throw new Error(text);
  }

  const data = await response.json();
  const output = data.output?.[0]?.content?.[0]?.text || data.output_text || "";
  return output;
}

function buildPrompt(packType, count) {
  if (packType === "level2") {
    return `You are generating toddler-friendly English words. Output STRICT JSON only.\n\nTask: Generate ${count} English words of length 1-3 letters. Use only lowercase a-z. Avoid proper nouns, slang, or unsafe words.\n\nOutput format: {"words": ["cat", "sun", ...]}\nNo extra text.`;
  }
  if (packType === "level3") {
    return `You are generating toddler-friendly English words. Output STRICT JSON only.\n\nTask: Generate ${count} English words of length 3-7 letters. Use only lowercase a-z. Avoid proper nouns, slang, or unsafe words.\n\nOutput format: {"words": ["apple", "garden", ...]}\nNo extra text.`;
  }
  return `You are generating simple English words for toddler sentences. Output STRICT JSON only.\n\nTask: Generate ${count} simple English words suitable for building short sentences. Use only lowercase a-z. Avoid proper nouns, slang, or unsafe words.\n\nOutput format: {"words": ["the", "dog", "runs", ...]}\nNo extra text.`;
}

async function generateWithRetry({ apiKey, packType, count }) {
  const prompt = buildPrompt(packType, count);
  let output = await callOpenAI({ apiKey, prompt });
  let json;
  try {
    json = JSON.parse(output);
  } catch {
    output = await callOpenAI({ apiKey, prompt });
    json = JSON.parse(output);
  }
  if (!json.words || !Array.isArray(json.words)) throw new Error("Invalid JSON structure");
  const cleaned = sanitizeList(json.words);
  return filterWordsByType(cleaned, packType);
}

function ensureDumpDir() {
  if (!fs.existsSync(DB_SWITCH_DUMP_DIR)) fs.mkdirSync(DB_SWITCH_DUMP_DIR, { recursive: true });
}

function appendSwitchAudit(entry) {
  ensureDumpDir();
  fs.appendFileSync(DB_SWITCH_AUDIT_LOG, `${JSON.stringify(entry)}\n`);
}

async function switchToTargetDb({ target, requestedBy }) {
  const sourceDriver = activeDriver;
  if (sourceDriver === target) {
    return { ok: true, message: `Already on ${target}`, sourceDriver, targetDriver: target };
  }

  maintenanceMode = true;
  ensureDumpDir();
  appendSwitchAudit({ ts: new Date().toISOString(), action: "switch_start", requestedBy, sourceDriver, target });

  if (target === "postgres" && DB_SWITCH_POSTGRES_UP_CMD) {
    await execAsync(DB_SWITCH_POSTGRES_UP_CMD);
  }

  const sourceDump = await repo.dumpAll();
  const dumpFile = path.join(DB_SWITCH_DUMP_DIR, `switch-${Date.now()}-${sourceDriver}-to-${target}.json`);
  fs.writeFileSync(dumpFile, JSON.stringify({ sourceDriver, targetDriver: target, dump: sourceDump }, null, 2));

  const targetAdapter = await createAdapter(target);
  await targetAdapter.restoreAll(sourceDump);

  const sourceCounts = await repo.counts();
  const targetCounts = await targetAdapter.counts();

  const verifyOk = JSON.stringify(sourceCounts) === JSON.stringify(targetCounts);
  if (!verifyOk) {
    await targetAdapter.close();
    maintenanceMode = false;
    appendSwitchAudit({ ts: new Date().toISOString(), action: "switch_failed_verify", requestedBy, sourceDriver, target, sourceCounts, targetCounts });
    throw new Error(`Verification failed source=${JSON.stringify(sourceCounts)} target=${JSON.stringify(targetCounts)}`);
  }

  await repo.close();
  repo = targetAdapter;
  activeDriver = target;

  writeRuntimeConfig({
    ...readRuntimeConfig(),
    activeDriver: target,
    lastSwitchAt: new Date().toISOString(),
    lastSwitchBy: requestedBy || "unknown",
    previousDriver: sourceDriver,
    lastDumpFile: dumpFile
  });

  if (DB_SWITCH_RESTART_CMD) {
    await execAsync(DB_SWITCH_RESTART_CMD);
  }

  maintenanceMode = false;
  appendSwitchAudit({ ts: new Date().toISOString(), action: "switch_success", requestedBy, sourceDriver, target, dumpFile, sourceCounts, targetCounts });
  return {
    ok: true,
    sourceDriver,
    targetDriver: target,
    verify: { sourceCounts, targetCounts },
    dumpFile,
    runtimeConfig: RUNTIME_CONFIG_PATH,
    restartCommandRan: Boolean(DB_SWITCH_RESTART_CMD)
  };
}

async function rollbackDbSwitch(requestedBy) {
  const runtime = readRuntimeConfig();
  if (!runtime.lastDumpFile || !fs.existsSync(runtime.lastDumpFile)) {
    throw new Error("No rollback dump available");
  }

  const content = JSON.parse(fs.readFileSync(runtime.lastDumpFile, "utf8"));
  const rollbackTarget = content.sourceDriver;
  const dump = content.dump;

  maintenanceMode = true;
  appendSwitchAudit({ ts: new Date().toISOString(), action: "rollback_start", requestedBy, activeDriver, rollbackTarget });

  const targetAdapter = await createAdapter(rollbackTarget);
  await targetAdapter.restoreAll(dump);

  await repo.close();
  repo = targetAdapter;
  activeDriver = rollbackTarget;

  writeRuntimeConfig({
    ...runtime,
    activeDriver: rollbackTarget,
    rolledBackAt: new Date().toISOString(),
    rolledBackBy: requestedBy || "unknown"
  });

  if (DB_SWITCH_RESTART_CMD) {
    await execAsync(DB_SWITCH_RESTART_CMD);
  }

  maintenanceMode = false;
  appendSwitchAudit({ ts: new Date().toISOString(), action: "rollback_success", requestedBy, activeDriver });
  return { ok: true, activeDriver, rollbackFrom: content.targetDriver, rollbackTo: rollbackTarget };
}

app.get("/healthz", (req, res) => {
  res.json({ ok: true, service: "ktrain", driver: activeDriver, maintenanceMode });
});

app.get("/readyz", async (req, res) => {
  try {
    await repo.ping();
    res.json({ ok: true, ready: true, driver: activeDriver });
  } catch (err) {
    res.status(503).json({ ok: false, ready: false, error: "DB not reachable" });
  }
});

app.get("/api/health", (req, res) => {
  res.json({ ok: true, driver: activeDriver, dbDriverEnv: DB_DRIVER_ENV });
});

app.get("/api/public/session", (req, res) => {
  res.json({ ok: true, isAdmin: isAdmin(req) });
});

app.get("/api/settings", requireAdmin, async (req, res) => {
  const settings = await loadSettings(repo);
  res.json({ settings });
});

app.put("/api/settings", requireAdmin, async (req, res) => {
  const settings = await saveSettings(repo, req.body || {});
  res.json({ settings });
});

app.post("/api/tasks/generate", requireNotMaintenance, async (req, res) => {
  const { level, count, contentMode } = req.body || {};
  const safeLevel = Number(level);
  const safeCount = Math.min(Math.max(Number(count) || 10, 5), 100);
  const safeContentMode = contentMode === "vocab" ? "vocab" : "default";
  if (![1, 2, 3, 4, 5].includes(safeLevel)) return res.status(400).json({ error: "Invalid level" });
  const tasks = await generateTasks(safeLevel, safeCount, safeContentMode);
  res.json({ tasks });
});

app.post("/api/results", requireNotMaintenance, resultsLimiter, async (req, res) => {
  const body = req.body || {};
  if (body.mode && body.mode !== "contest") return res.json({ ok: true, saved: false });

  const createdAt = new Date().toISOString();
  const contestType = body.contestType === "tasks" ? "tasks" : "time";
  const level = clampNumber(body.level, 1, 5, 1);
  const contentMode = body.contentMode === "vocab" ? "vocab" : "default";
  const duration = contestType === "time" ? clampNumber(body.duration, 30, 120, 60) : null;
  const taskTarget = contestType === "tasks" ? clampNumber(body.taskTarget, 10, 50, 20) : null;
  const accuracy = clampNumber(body.accuracy, 0, 100, 0);

  await repo.insertLeaderboard({
    playerName: cleanName(body.playerName),
    createdAt,
    contestType,
    level,
    contentMode,
    duration,
    taskTarget,
    score: clampNumber(body.score, 0, 1_000_000, 0),
    accuracy,
    cpm: clampNumber(body.cpm, 0, 10_000, 0),
    mistakes: clampNumber(body.mistakes, 0, 100_000, 0),
    tasksCompleted: clampNumber(body.tasksCompleted, 0, 100_000, 0),
    timeSeconds: clampNumber(body.timeSeconds, 0, 100_000, 0),
    maxStreak: clampNumber(body.maxStreak, 0, 100_000, 0)
  });

  res.json({ ok: true, saved: true });
});

app.get("/api/leaderboard", async (req, res) => {
  const entries = await repo.queryLeaderboard(req.query || {});
  res.json({ entries });
});

app.get("/api/vocab/packs", async (req, res) => {
  const packs = await repo.listPacks();
  res.json({
    packs: packs.map((pack) => ({
      ...pack,
      items: typeof pack.items === "string" ? JSON.parse(pack.items) : pack.items
    }))
  });
});

app.post("/api/vocab/packs/:id/activate", requireAdmin, adminLimiter, async (req, res) => {
  const id = Number(req.params.id);
  const pack = await repo.getPackById(id);
  if (!pack) return res.status(404).json({ error: "Not found" });
  await repo.activatePack(id, pack.packtype || pack.packType);
  res.json({ ok: true });
});

app.put("/api/vocab/packs/:id", requireAdmin, adminLimiter, async (req, res) => {
  const id = Number(req.params.id);
  const { name, items } = req.body || {};
  const cleaned = Array.isArray(items) ? sanitizeList(items) : null;
  if (!cleaned || cleaned.length === 0) return res.status(400).json({ error: "Invalid items" });
  await repo.updatePack(id, name, JSON.stringify(cleaned));
  res.json({ ok: true });
});

app.delete("/api/vocab/packs/:id", requireAdmin, adminLimiter, async (req, res) => {
  await repo.deletePack(Number(req.params.id));
  res.json({ ok: true });
});

app.post("/api/vocab/generate", requireAdmin, adminLimiter, async (req, res) => {
  const { name, count, packType, apiKey, storeKey } = req.body || {};
  const safeCount = Math.min(Math.max(Number(count) || 20, 10), 200);
  const safeType = ["level2", "level3", "sentence_words"].includes(packType) ? packType : "level2";

  let keyToUse = null;
  if (storeKey) {
    if (apiKey) await setSetting("openai_key", apiKey);
    keyToUse = apiKey || await getSetting("openai_key");
  } else {
    keyToUse = apiKey;
  }

  if (!keyToUse) return res.status(400).json({ error: "OpenAI key required" });

  try {
    const words = await generateWithRetry({ apiKey: keyToUse, packType: safeType, count: safeCount });
    await repo.insertPack({
      name: name || "Generated Pack",
      packType: safeType,
      itemsJson: JSON.stringify(words),
      active: 0,
      createdAt: new Date().toISOString()
    });
    res.json({ ok: true, count: words.length });
  } catch {
    res.status(500).json({ error: "Generation failed" });
  }
});

app.post("/api/admin/openai/test", requireAdmin, adminLimiter, async (req, res) => {
  const { apiKey, storeKey } = req.body || {};
  let keyToUse = apiKey;
  if (storeKey) {
    if (apiKey) await setSetting("openai_key", apiKey);
    keyToUse = apiKey || await getSetting("openai_key");
  }
  if (!keyToUse) return res.status(400).json({ error: "Key required" });

  try {
    await callOpenAI({ apiKey: keyToUse, prompt: "Return STRICT JSON: {\"ok\": true}" });
    res.json({ ok: true });
  } catch {
    res.status(400).json({ ok: false });
  }
});

app.post("/api/admin/reset", requireAdmin, adminLimiter, async (req, res) => {
  const scope = req.body?.scope || "all";
  await repo.reset(scope);
  res.json({ ok: true });
});

app.post("/api/admin/seed-defaults", requireAdmin, adminLimiter, async (req, res) => {
  const now = new Date().toISOString();
  await repo.reset("vocab");
  await repo.insertPack({ name: "Default Level 2", packType: "level2", itemsJson: JSON.stringify(defaults.level2Words), active: 1, createdAt: now });
  await repo.insertPack({ name: "Default Level 3", packType: "level3", itemsJson: JSON.stringify(defaults.level3Words), active: 1, createdAt: now });
  await repo.insertPack({ name: "Default Sentence Words", packType: "sentence_words", itemsJson: JSON.stringify(defaults.sentenceWords), active: 1, createdAt: now });
  res.json({ ok: true });
});

app.get("/api/admin/db/status", requireAdmin, adminLimiter, async (req, res) => {
  const runtime = readRuntimeConfig();
  const counts = await repo.counts();
  res.json({
    ok: true,
    activeDriver,
    maintenanceMode,
    dbDriverEnv: DB_DRIVER_ENV,
    dbConfig: resolveDbConfig(),
    runtime,
    counts
  });
});

app.get("/api/admin/db/config", requireAdmin, adminLimiter, async (req, res) => {
  res.json({
    ok: true,
    activeDriver,
    dbConfig: resolveDbConfig(),
    runtime: readRuntimeConfig()
  });
});

app.post("/api/admin/db/config", requireAdmin, adminLimiter, async (req, res) => {
  try {
    const nextConfig = sanitizeDbConfig(req.body || {});
    const runtime = readRuntimeConfig();
    writeRuntimeConfig({
      ...runtime,
      dbConfig: nextConfig,
      dbConfigUpdatedAt: new Date().toISOString(),
      dbConfigUpdatedBy: req.headers["x-forwarded-user"] || "admin"
    });

    if (req.body?.verify) {
      const probe = await createAdapter("postgres");
      await probe.ping();
      await probe.close();
    }

    if (req.body?.restart && DB_SWITCH_RESTART_CMD) {
      await execAsync(DB_SWITCH_RESTART_CMD);
    }

    return res.json({ ok: true, dbConfig: nextConfig, activeDriver });
  } catch (err) {
    return res.status(400).json({ ok: false, error: String(err.message || err) });
  }
});

app.post("/api/admin/db/test", requireAdmin, adminLimiter, async (req, res) => {
  try {
    const postgres = req.body?.postgres || {};
    await testPostgresConfig(postgres);
    return res.json({ ok: true, message: "Postgres connection successful" });
  } catch (err) {
    return res.status(400).json({ ok: false, error: String(err.message || err) });
  }
});

app.post("/api/admin/db/switch", requireAdmin, adminLimiter, async (req, res) => {
  const target = req.body?.target;
  const mode = req.body?.mode || "copy-then-switch";
  const verify = req.body?.verify !== false;
  if (!["sqlite", "postgres"].includes(target)) {
    return res.status(400).json({ error: "target must be sqlite or postgres" });
  }
  if (mode !== "copy-then-switch") {
    return res.status(400).json({ error: "Only copy-then-switch mode is supported" });
  }

  try {
    const result = await switchToTargetDb({ target, requestedBy: req.headers["x-forwarded-user"] || "admin" });
    if (verify && result.verify && JSON.stringify(result.verify.sourceCounts) !== JSON.stringify(result.verify.targetCounts)) {
      return res.status(500).json({ ok: false, error: "Verification mismatch", result });
    }
    return res.json(result);
  } catch (err) {
    maintenanceMode = false;
    return res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

app.post("/api/admin/db/rollback", requireAdmin, adminLimiter, async (req, res) => {
  try {
    const result = await rollbackDbSwitch(req.headers["x-forwarded-user"] || "admin");
    return res.json(result);
  } catch (err) {
    maintenanceMode = false;
    return res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

const clientDist = path.join(__dirname, "../client/dist");
const indexHtml = path.join(clientDist, "index.html");
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get(["/admin*", "/settings-admin*"], (req, res, next) => {
    if (!isAdmin(req)) return res.status(403).send("Forbidden");
    return next();
  });
  app.get("*", (req, res) => {
    if (fs.existsSync(indexHtml)) return res.sendFile(indexHtml);
    return res.status(404).json({ error: "Frontend not built" });
  });
}

async function start() {
  const dbState = await initDb();
  repo = dbState.adapter;
  activeDriver = dbState.driver;

  app.listen(PORT, () => {
    console.log(`Server running on ${PORT} driver=${activeDriver}`);
  });
}

start().catch((err) => {
  console.error("Failed to start server", err);
  process.exit(1);
});
