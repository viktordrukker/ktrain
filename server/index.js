require("dotenv").config();

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const path = require("path");
const fs = require("fs");
const { exec } = require("child_process");
const { promisify } = require("util");
const { initDb, createAdapter, resolveDriver, DB_DRIVER_ENV, resolveDbConfig, sanitizeDbConfig, testPostgresConfig, getMigrationStatus, rollbackLastMigration } = require("./db");
const { loadSettings, saveSettings } = require("./settings");
const { readRuntimeConfig, writeRuntimeConfig, RUNTIME_CONFIG_PATH } = require("./db/runtime-config");
const { Roles, Permissions, normalizeRole, hasPermission } = require("./src/domain/rbac");
const { resolveActor } = require("./src/application/identity");
const { checkConfigSchema, checkMigrations, checkRequiredIndexes, checkEncryption } = require("./src/application/self-checks");
const { requestContextMiddleware, requirePermission, withAsync, errorHandler } = require("./src/interface/http/middleware");
const { asEnum, asNumber, asString, parseJsonArrayOfStrings, requireObject } = require("./src/interface/http/validation");
const { ConfigStore, SAFE_CONFIG_KEYS } = require("./src/infrastructure/config/config-store");
const { EncryptionService } = require("./src/infrastructure/security/encryption");
const logger = require("./src/shared/logger");
const { AppError, badRequest } = require("./src/shared/errors");
const defaults = require("./data/defaults");

const execAsync = promisify(exec);

const app = express();
let repo;
let configStore;
let encryptionService;
let activeDriver = resolveDriver();
let maintenanceMode = false;
let startupSelfChecks = {};

const PORT = process.env.PORT || 3000;
const ADMIN_PIN = process.env.ADMIN_PIN || "change-me";
const OWNER_EMAIL = process.env.OWNER_EMAIL || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const AUTH_OWNER_GROUPS = String(process.env.AUTH_OWNER_GROUPS || "owners").split(",").map((x) => x.trim()).filter(Boolean);
const AUTH_ADMIN_GROUPS = String(process.env.AUTH_ADMIN_GROUPS || "admins,ldap-admins").split(",").map((x) => x.trim()).filter(Boolean);
const AUTH_MODERATOR_GROUPS = String(process.env.AUTH_MODERATOR_GROUPS || "moderators").split(",").map((x) => x.trim()).filter(Boolean);
const AUTH_TRUST_PROXY = String(process.env.AUTH_TRUST_PROXY || "true") === "true";
const AUTH_TRUSTED_PROXY_IPS = String(process.env.AUTH_TRUSTED_PROXY_IPS || "").split(",").map((x) => x.trim()).filter(Boolean);
const DB_SWITCH_RESTART_CMD = process.env.DB_SWITCH_RESTART_CMD || "";
const DB_SWITCH_POSTGRES_UP_CMD = process.env.DB_SWITCH_POSTGRES_UP_CMD || "";
const DB_SWITCH_DUMP_DIR = process.env.DB_SWITCH_DUMP_DIR || "/data/db-switch";
const DB_SWITCH_AUDIT_LOG = process.env.DB_SWITCH_AUDIT_LOG || "/data/db-switch/switch-audit.log";

if (AUTH_TRUST_PROXY) {
  app.set("trust proxy", true);
}

app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      defaultSrc: ["'self'"],
      connectSrc: ["'self'"],
      scriptSrc: ["'self'"],
      imgSrc: ["'self'", "data:"],
      mediaSrc: ["'self'", "data:"],
      styleSrc: ["'self'", "'unsafe-inline'"]
    }
  },
  referrerPolicy: { policy: "no-referrer" }
}));
app.use(cors());
app.use(express.json({ limit: "2mb" }));
app.disable("x-powered-by");

app.use(requestContextMiddleware());
app.use(withAsync(resolveRequestActor));

function getCurrentAdminPin() {
  const runtime = readRuntimeConfig();
  return String(runtime.adminPin || ADMIN_PIN);
}

async function resolveRequestActor(req, res, next) {
  req.actor = await resolveActor({
    req,
    repo,
    getAdminPin: getCurrentAdminPin,
    options: {
      ownerEmail: OWNER_EMAIL,
      authTrustProxy: AUTH_TRUST_PROXY,
      trustedProxyIps: AUTH_TRUSTED_PROXY_IPS,
      ownerGroups: AUTH_OWNER_GROUPS,
      adminGroups: AUTH_ADMIN_GROUPS,
      moderatorGroups: AUTH_MODERATOR_GROUPS
    }
  });
  return next();
}

async function audit(req, action, targetType, targetId, metadata = null) {
  if (!repo?.insertAuditLog) return;
  await repo.insertAuditLog({
    actorUserId: req.actor?.id || null,
    actorRole: req.actor?.role || Roles.GUEST,
    action,
    targetType,
    targetId,
    metadata,
    requestId: req.requestId,
    ip: req.ip,
    createdAt: new Date().toISOString()
  });
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
const generationLimiter = createRateLimiter({ windowMs: 60_000, max: 30 });

async function getSetting(key) {
  return repo.getSetting(key);
}

async function setSetting(key, value) {
  await repo.setSetting(key, value);
}

async function storeOpenAIKeyForActor(actor, apiKey) {
  if (!apiKey) return;
  if (actor?.id && encryptionService?.isConfigured()) {
    // SECURITY: OpenAI keys are encrypted at rest with AES-256-GCM and never logged.
    const encrypted = encryptionService.encrypt(apiKey);
    await repo.upsertUserSecret(actor.id, "openai_api_key", encrypted);
    return;
  }
  await setSetting("openai_key", apiKey);
}

async function getOpenAIKeyForActor(actor) {
  if (actor?.id && encryptionService?.isConfigured()) {
    const row = await repo.getUserSecret(actor.id, "openai_api_key");
    if (row) {
      return encryptionService.decrypt({
        ciphertext: row.ciphertext,
        iv: row.iv,
        authTag: row.authtag || row.authTag
      });
    }
  }
  return getSetting("openai_key");
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
  const role = normalizeRole(req.actor?.role || Roles.GUEST);
  res.json({ ok: true, isAdmin: role === Roles.ADMIN || role === Roles.OWNER, role, actor: req.actor || null });
});

app.get("/api/settings", requirePermission(Permissions.SETTINGS_READ), withAsync(async (req, res) => {
  const settings = await loadSettings(repo);
  res.json({ settings });
}));

app.put("/api/settings", requirePermission(Permissions.SETTINGS_WRITE), withAsync(async (req, res) => {
  const payload = requireObject(req.body || {}, "settings");
  const settings = await saveSettings(repo, payload);
  await configStore.setSafe("app.settings", settings, { scope: "global", scopeId: "global", updatedBy: req.actor?.externalSubject || "admin" });
  await audit(req, "settings.update", "settings", "app_settings_v2");
  res.json({ settings });
}));

app.post("/api/tasks/generate", requirePermission(Permissions.TASKS_GENERATE), requireNotMaintenance, generationLimiter, withAsync(async (req, res) => {
  const body = requireObject(req.body || {}, "body");
  const safeLevel = asNumber(body.level, { min: 1, max: 5, field: "level" });
  const safeCount = asNumber(body.count ?? 10, { min: 5, max: 100, field: "count" });
  const safeContentMode = body.contentMode === "vocab" ? "vocab" : "default";
  const tasks = await generateTasks(safeLevel, safeCount, safeContentMode);
  res.json({ tasks });
}));

app.post("/api/results", requirePermission(Permissions.RESULTS_WRITE), requireNotMaintenance, resultsLimiter, withAsync(async (req, res) => {
  const body = requireObject(req.body || {}, "result");
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
}));

app.get("/api/leaderboard", requirePermission(Permissions.LEADERBOARD_READ), withAsync(async (req, res) => {
  const entries = await repo.queryLeaderboard(req.query || {});
  res.json({ entries });
}));

app.get("/api/vocab/packs", requirePermission(Permissions.VOCAB_READ), withAsync(async (req, res) => {
  const packs = await repo.listPacks();
  res.json({
    packs: packs.map((pack) => ({
      ...pack,
      items: typeof pack.items === "string" ? JSON.parse(pack.items) : pack.items
    }))
  });
}));

app.post("/api/vocab/packs/:id/activate", requirePermission(Permissions.VOCAB_MANAGE), adminLimiter, withAsync(async (req, res) => {
  const id = asNumber(req.params.id, { min: 1, field: "id" });
  const pack = await repo.getPackById(id);
  if (!pack) throw new AppError("Not found", { status: 404, code: "NOT_FOUND", expose: true });
  await repo.activatePack(id, pack.packtype || pack.packType);
  await audit(req, "vocab.activate", "vocab_pack", String(id));
  res.json({ ok: true });
}));

app.put("/api/vocab/packs/:id", requirePermission(Permissions.VOCAB_MANAGE), adminLimiter, withAsync(async (req, res) => {
  const id = asNumber(req.params.id, { min: 1, field: "id" });
  const body = requireObject(req.body || {}, "body");
  const cleaned = parseJsonArrayOfStrings(body.items, "items");
  await repo.updatePack(id, body.name || null, JSON.stringify(sanitizeList(cleaned)));
  await audit(req, "vocab.update", "vocab_pack", String(id), { count: cleaned.length });
  res.json({ ok: true });
}));

app.delete("/api/vocab/packs/:id", requirePermission(Permissions.VOCAB_MANAGE), adminLimiter, withAsync(async (req, res) => {
  const id = asNumber(req.params.id, { min: 1, field: "id" });
  await repo.deletePack(id);
  await audit(req, "vocab.delete", "vocab_pack", String(id));
  res.json({ ok: true });
}));

app.post("/api/vocab/generate", requirePermission(Permissions.VOCAB_MANAGE), adminLimiter, generationLimiter, withAsync(async (req, res) => {
  const body = requireObject(req.body || {}, "body");
  const safeCount = asNumber(body.count ?? 20, { min: 10, max: 200, field: "count" });
  const safeType = asEnum(body.packType || "level2", ["level2", "level3", "sentence_words"], "packType");

  let keyToUse = body.apiKey || null;
  if (body.storeKey && body.apiKey) {
    await storeOpenAIKeyForActor(req.actor, String(body.apiKey));
  }
  if (!keyToUse && body.storeKey) {
    keyToUse = await getOpenAIKeyForActor(req.actor);
  }
  if (!keyToUse) throw badRequest("OpenAI key required");

  const words = await generateWithRetry({ apiKey: keyToUse, packType: safeType, count: safeCount });
  await repo.insertPack({
    name: body.name || "Generated Pack",
    packType: safeType,
    itemsJson: JSON.stringify(words),
    active: 0,
    createdAt: new Date().toISOString()
  });
  await audit(req, "vocab.generate", "vocab_pack", safeType, { count: words.length });
  res.json({ ok: true, count: words.length });
}));

app.post("/api/admin/openai/test", requirePermission(Permissions.ADMIN_SECRET_MANAGE), adminLimiter, generationLimiter, withAsync(async (req, res) => {
  const body = requireObject(req.body || {}, "body");
  let keyToUse = body.apiKey || null;
  if (body.storeKey && body.apiKey) {
    await storeOpenAIKeyForActor(req.actor, String(body.apiKey));
  }
  if (!keyToUse && body.storeKey) keyToUse = await getOpenAIKeyForActor(req.actor);
  if (!keyToUse) throw badRequest("Key required");
  await callOpenAI({ apiKey: keyToUse, prompt: "Return STRICT JSON: {\"ok\": true}" });
  await audit(req, "secret.openai.test", "secret", "openai_api_key");
  res.json({ ok: true });
}));

app.post("/api/admin/reset", requirePermission(Permissions.ADMIN_RESET), adminLimiter, withAsync(async (req, res) => {
  const scope = asEnum(req.body?.scope || "all", ["all", "leaderboard", "results", "vocab"], "scope");
  await repo.reset(scope);
  await audit(req, "admin.reset", "scope", scope);
  res.json({ ok: true });
}));

app.get("/api/admin/pin/status", requirePermission(Permissions.ADMIN_PIN_MANAGE), adminLimiter, withAsync(async (req, res) => {
  const current = getCurrentAdminPin();
  res.json({
    ok: true,
    pinIsDefault: current === "change-me",
    source: readRuntimeConfig().adminPin ? "runtime" : "env"
  });
}));

app.post("/api/admin/pin/change", requirePermission(Permissions.ADMIN_PIN_MANAGE), adminLimiter, withAsync(async (req, res) => {
  const { currentPin, newPin } = req.body || {};
  const activePin = getCurrentAdminPin();
  const pinFromHeader = String(req.headers["x-admin-pin"] || "");

  if (pinFromHeader && pinFromHeader !== activePin) {
    throw new AppError("Invalid current admin pin", { status: 403, code: "FORBIDDEN", expose: true });
  }
  if (!pinFromHeader && currentPin && String(currentPin) !== activePin) {
    throw new AppError("Current pin mismatch", { status: 403, code: "FORBIDDEN", expose: true });
  }

  const candidate = asString(newPin || "", { min: 6, max: 128, field: "newPin" });
  if (candidate === "change-me") {
    throw badRequest("New pin cannot be the default value");
  }

  const runtime = readRuntimeConfig();
  writeRuntimeConfig({
    ...runtime,
    adminPin: candidate,
    adminPinUpdatedAt: new Date().toISOString(),
    adminPinUpdatedBy: req.actor?.externalSubject || "admin"
  });
  await audit(req, "admin.pin.change", "runtime", "adminPin");
  res.json({ ok: true, pinChanged: true });
}));

app.post("/api/admin/seed-defaults", requirePermission(Permissions.ADMIN_SEED_DEFAULTS), adminLimiter, withAsync(async (req, res) => {
  const now = new Date().toISOString();
  await repo.reset("vocab");
  await repo.insertPack({ name: "Default Level 2", packType: "level2", itemsJson: JSON.stringify(defaults.level2Words), active: 1, createdAt: now });
  await repo.insertPack({ name: "Default Level 3", packType: "level3", itemsJson: JSON.stringify(defaults.level3Words), active: 1, createdAt: now });
  await repo.insertPack({ name: "Default Sentence Words", packType: "sentence_words", itemsJson: JSON.stringify(defaults.sentenceWords), active: 1, createdAt: now });
  await audit(req, "admin.seed.defaults", "vocab", "defaults");
  res.json({ ok: true });
}));

app.get("/api/admin/db/status", requirePermission(Permissions.ADMIN_DB_READ), adminLimiter, withAsync(async (req, res) => {
  const runtime = readRuntimeConfig();
  const counts = await repo.counts();
  const migrations = await getMigrationStatus(repo, activeDriver);
  res.json({
    ok: true,
    activeDriver,
    maintenanceMode,
    dbDriverEnv: DB_DRIVER_ENV,
    dbConfig: resolveDbConfig(),
    runtime,
    counts,
    migrations
  });
}));

app.get("/api/admin/db/config", requirePermission(Permissions.ADMIN_DB_READ), adminLimiter, withAsync(async (req, res) => {
  res.json({
    ok: true,
    activeDriver,
    dbConfig: resolveDbConfig(),
    runtime: readRuntimeConfig()
  });
}));

app.post("/api/admin/db/config", requirePermission(Permissions.ADMIN_DB_CONFIG), adminLimiter, withAsync(async (req, res) => {
  const nextConfig = sanitizeDbConfig(req.body || {});
  const runtime = readRuntimeConfig();
  writeRuntimeConfig({
    ...runtime,
    dbConfig: nextConfig,
    dbConfigUpdatedAt: new Date().toISOString(),
    dbConfigUpdatedBy: req.actor?.externalSubject || "admin"
  });

  if (req.body?.verify) {
    const probe = await createAdapter("postgres");
    await probe.ping();
    await probe.close();
  }

  if (req.body?.restart && DB_SWITCH_RESTART_CMD) {
    await execAsync(DB_SWITCH_RESTART_CMD);
  }
  await audit(req, "admin.db.config.update", "db_config", activeDriver);
  res.json({ ok: true, dbConfig: nextConfig, activeDriver });
}));

app.post("/api/admin/db/test", requirePermission(Permissions.ADMIN_DB_TEST), adminLimiter, withAsync(async (req, res) => {
  const postgres = req.body?.postgres || {};
  await testPostgresConfig(postgres);
  await audit(req, "admin.db.test", "postgres", postgres.host || "connectionString");
  res.json({ ok: true, message: "Postgres connection successful" });
}));

app.post("/api/admin/db/switch", requirePermission(Permissions.ADMIN_DB_SWITCH), adminLimiter, withAsync(async (req, res) => {
  const target = asEnum(req.body?.target, ["sqlite", "postgres"], "target");
  const mode = req.body?.mode || "copy-then-switch";
  const verify = req.body?.verify !== false;
  if (mode !== "copy-then-switch") {
    throw badRequest("Only copy-then-switch mode is supported");
  }
  const result = await switchToTargetDb({ target, requestedBy: req.actor?.externalSubject || "admin" });
  if (verify && result.verify && JSON.stringify(result.verify.sourceCounts) !== JSON.stringify(result.verify.targetCounts)) {
    throw new AppError("Verification mismatch", { status: 500, code: "VERIFY_MISMATCH", expose: true });
  }
  await audit(req, "admin.db.switch", "driver", target, result.verify || null);
  res.json(result);
}));

app.post("/api/admin/db/rollback", requirePermission(Permissions.ADMIN_DB_ROLLBACK), adminLimiter, withAsync(async (req, res) => {
  const result = await rollbackDbSwitch(req.actor?.externalSubject || "admin");
  await audit(req, "admin.db.rollback", "driver", result.rollbackTo || activeDriver);
  res.json(result);
}));

app.post("/api/admin/db/migrations/rollback-last", requirePermission(Permissions.ADMIN_DB_CONFIG), adminLimiter, withAsync(async (req, res) => {
  const result = await rollbackLastMigration(repo, activeDriver);
  await audit(req, "admin.db.migration.rollback_last", "migration", result.rolledBack || "none", result);
  res.json(result);
}));

app.post("/api/admin/owner/bootstrap", requirePermission(Permissions.OWNER_BOOTSTRAP), adminLimiter, withAsync(async (req, res) => {
  const confirm = Boolean(req.body?.confirm);
  if (!confirm) throw badRequest("Confirmation required");
  const owner = await repo.getOwnerUser();
  if (owner) throw badRequest("Owner already exists");
  if (!req.actor?.id) throw badRequest("Authenticated user required");
  const updated = await repo.updateUserRole(req.actor.id, Roles.OWNER);
  await audit(req, "owner.bootstrap", "user", String(req.actor.id));
  res.json({ ok: true, owner: updated });
}));

app.get("/api/admin/users", requirePermission(Permissions.ADMIN_AUDIT_READ), adminLimiter, withAsync(async (req, res) => {
  const users = await repo.listUsers();
  res.json({ ok: true, users });
}));

app.post("/api/admin/users/:id/role", requirePermission(Permissions.USER_ROLE_ASSIGN), adminLimiter, withAsync(async (req, res) => {
  const targetUserId = asNumber(req.params.id, { min: 1, field: "id" });
  const role = asEnum(String(req.body?.role || "").toUpperCase(), Object.values(Roles), "role");
  const updated = await repo.updateUserRole(targetUserId, role);
  if (!updated) throw new AppError("User not found", { status: 404, code: "NOT_FOUND", expose: true });
  await audit(req, "user.role.assign", "user", String(targetUserId), { role });
  res.json({ ok: true, user: updated });
}));

app.get("/api/admin/config", requirePermission(Permissions.ADMIN_CONFIG_MANAGE), adminLimiter, withAsync(async (req, res) => {
  const rows = await configStore.list({ scope: "global", scopeId: "global" });
  res.json({ ok: true, safeKeys: Array.from(SAFE_CONFIG_KEYS), rows });
}));

app.post("/api/admin/config", requirePermission(Permissions.ADMIN_CONFIG_MANAGE), adminLimiter, withAsync(async (req, res) => {
  const key = asString(req.body?.key || "", { min: 1, max: 128, field: "key" });
  const scope = asEnum(req.body?.scope || "global", ["global", "tenant", "user"], "scope");
  const scopeId = asString(req.body?.scopeId || "global", { min: 1, max: 128, field: "scopeId" });
  const value = req.body?.valueJson;
  const result = await configStore.setSafe(key, value, {
    scope,
    scopeId,
    updatedBy: req.actor?.externalSubject || "admin"
  });
  await audit(req, "config.update", "config", `${scope}:${scopeId}:${key}`);
  res.json({ ok: true, config: result });
}));

app.get("/api/admin/config/export", requirePermission(Permissions.ADMIN_CONFIG_PORTABILITY), adminLimiter, withAsync(async (req, res) => {
  const rows = await configStore.exportSafeConfig();
  res.json({ ok: true, rows });
}));

app.post("/api/admin/config/import", requirePermission(Permissions.ADMIN_CONFIG_PORTABILITY), adminLimiter, withAsync(async (req, res) => {
  const rows = req.body?.rows;
  await configStore.importSafeConfig(rows, req.actor?.externalSubject || "admin");
  await audit(req, "config.import", "config", "global", { count: Array.isArray(rows) ? rows.length : 0 });
  res.json({ ok: true });
}));

app.get("/api/diagnostics/rbac", requirePermission(Permissions.ADMIN_DIAGNOSTICS_READ), adminLimiter, (req, res) => {
  res.json({
    ok: true,
    actor: req.actor,
    permissions: Object.values(Permissions).filter((perm) => hasPermission(req.actor?.role || Roles.GUEST, perm))
  });
});

app.get("/api/diagnostics/db", requirePermission(Permissions.ADMIN_DIAGNOSTICS_READ), adminLimiter, withAsync(async (req, res) => {
  const migration = await getMigrationStatus(repo, activeDriver);
  const counts = await repo.counts();
  res.json({ ok: true, activeDriver, migration, counts, maintenanceMode });
}));

app.get("/api/diagnostics/config", requirePermission(Permissions.ADMIN_DIAGNOSTICS_READ), adminLimiter, withAsync(async (req, res) => {
  const schemaCheck = await checkConfigSchema(configStore);
  res.json({ ok: true, schemaCheck, safeKeys: Array.from(SAFE_CONFIG_KEYS) });
}));

app.get("/api/diagnostics/encryption", requirePermission(Permissions.ADMIN_DIAGNOSTICS_READ), adminLimiter, (req, res) => {
  res.json({ ok: true, encryption: checkEncryption(encryptionService) });
});

app.get("/api/diagnostics/startup", requirePermission(Permissions.ADMIN_DIAGNOSTICS_READ), adminLimiter, (req, res) => {
  res.json({ ok: true, startupSelfChecks });
});

app.get("/api/admin/audit-logs", requirePermission(Permissions.ADMIN_AUDIT_READ), adminLimiter, withAsync(async (req, res) => {
  const limit = asNumber(req.query.limit || 100, { min: 1, max: 500, field: "limit" });
  const logs = await repo.listAuditLogs(limit);
  res.json({ ok: true, logs });
}));

const clientDist = path.join(__dirname, "../client/dist");
const indexHtml = path.join(clientDist, "index.html");
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get(["/admin*", "/settings-admin*"], (req, res, next) => {
    const role = normalizeRole(req.actor?.role || Roles.GUEST);
    if (![Roles.ADMIN, Roles.OWNER].includes(role)) return res.status(403).send("Forbidden");
    return next();
  });
  app.get("*", (req, res) => {
    if (fs.existsSync(indexHtml)) return res.sendFile(indexHtml);
    return res.status(404).json({ error: "Frontend not built" });
  });
}

app.use(errorHandler());

async function ensureOwnerBootstrap() {
  if (!OWNER_EMAIL) return;
  const owner = await repo.getOwnerUser();
  if (owner) return;
  const byEmail = await repo.findUserByEmail(OWNER_EMAIL);
  if (byEmail) {
    await repo.updateUserRole(byEmail.id, Roles.OWNER);
    logger.warn("owner_bootstrap", { ownerEmail: OWNER_EMAIL, method: "promote_existing_user" });
    return;
  }
  // WHY: keep bootstrapping deterministic even before first SSO login.
  await repo.createUser({
    externalSubject: OWNER_EMAIL,
    email: OWNER_EMAIL,
    displayName: OWNER_EMAIL.split("@")[0] || "owner",
    role: Roles.OWNER
  });
  logger.warn("owner_bootstrap", { ownerEmail: OWNER_EMAIL, method: "create_owner_user" });
}

async function seedDefaultRuntimeConfig() {
  const existing = await configStore.list({ scope: "global", scopeId: "global" });
  if (existing.length > 0) return;
  await configStore.setSafe("app.features", { maintenanceMode: false }, { scope: "global", scopeId: "global", updatedBy: "bootstrap" });
  await configStore.setSafe("contest.rules", { maxAllowedLevel: 5, durations: [30, 60, 120], taskTargets: [10, 20, 50] }, { scope: "global", scopeId: "global", updatedBy: "bootstrap" });
  await configStore.setSafe("generator.defaults", { openAiModel: OPENAI_MODEL, maxCount: 200 }, { scope: "global", scopeId: "global", updatedBy: "bootstrap" });
}

async function start() {
  const dbState = await initDb();
  repo = dbState.adapter;
  activeDriver = dbState.driver;
  configStore = new ConfigStore({
    repo,
    ttlMs: Number(process.env.CONFIG_CACHE_TTL_MS || 5000)
  });
  encryptionService = new EncryptionService(process.env.KTRAIN_MASTER_KEY || "");

  await ensureOwnerBootstrap();
  await seedDefaultRuntimeConfig();

  startupSelfChecks = {
    configSchema: await checkConfigSchema(configStore),
    migrations: await checkMigrations(repo, activeDriver),
    indexes: await checkRequiredIndexes(repo),
    encryption: checkEncryption(encryptionService)
  };
  logger.info("startup_self_checks", startupSelfChecks);

  app.listen(PORT, () => {
    logger.info("server_started", { port: PORT, driver: activeDriver });
  });
}

start().catch((err) => {
  logger.error("server_start_failed", { error: err });
  process.exit(1);
});
