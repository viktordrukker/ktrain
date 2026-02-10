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
const {
  createAuthSession,
  getOrCreateUserByEmail,
  hashToken,
  normalizeEmail,
  validatePasswordPolicy,
  hashPassword,
  verifyPassword,
  upsertPasswordIdentity,
  getPasswordIdentityByEmail,
  createPasswordReset,
  consumePasswordReset
} = require("./src/application/auth");
const { seedBuiltinLanguagePacks, strictPrompt } = require("./src/application/language-packs");
const { checkConfigSchema, checkMigrations, checkRequiredIndexes, checkEncryption } = require("./src/application/self-checks");
const { requestContextMiddleware, requirePermission, withAsync, errorHandler } = require("./src/interface/http/middleware");
const { asEnum, asNumber, asString, parseJsonArrayOfStrings, requireObject } = require("./src/interface/http/validation");
const { ConfigStore, SAFE_CONFIG_KEYS } = require("./src/infrastructure/config/config-store");
const { EncryptionService } = require("./src/infrastructure/security/encryption");
const { SmtpService } = require("./src/infrastructure/email/smtp-service");
const { CrashHandler } = require("./src/infrastructure/reliability/crash-handler");
const logger = require("./src/shared/logger");
const { AppError, badRequest } = require("./src/shared/errors");
const defaults = require("./data/defaults");

const execAsync = promisify(exec);

const app = express();
let repo;
let configStore;
let encryptionService;
let smtpService;
let activeDriver = resolveDriver();
let maintenanceMode = false;
let startupSelfChecks = {};
let startupReady = false;
let startupPhase = "boot";
let shuttingDown = false;

const BUILD_INFO = {
  version: process.env.APP_VERSION || "0.0.0",
  build: process.env.APP_BUILD || "0",
  commit: process.env.APP_COMMIT || process.env.GIT_COMMIT || "unknown"
};

const PORT = process.env.PORT || 3000;
const OWNER_EMAIL = process.env.OWNER_EMAIL || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const APP_BASE_URL = process.env.APP_BASE_URL || "http://localhost:3000";
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const SESSION_COOKIE_NAME = process.env.SESSION_COOKIE_NAME || "ktrain_session";
const SESSION_TTL_MS = Number(process.env.SESSION_TTL_MS || 30 * 24 * 60 * 60 * 1000);
const AUTH_OWNER_GROUPS = String(process.env.AUTH_OWNER_GROUPS || "owners").split(",").map((x) => x.trim()).filter(Boolean);
const AUTH_ADMIN_GROUPS = String(process.env.AUTH_ADMIN_GROUPS || "admins,ldap-admins").split(",").map((x) => x.trim()).filter(Boolean);
const AUTH_MODERATOR_GROUPS = String(process.env.AUTH_MODERATOR_GROUPS || "moderators").split(",").map((x) => x.trim()).filter(Boolean);
const AUTH_TRUST_PROXY = String(process.env.AUTH_TRUST_PROXY || "true") === "true";
const AUTH_TRUSTED_PROXY_IPS = String(process.env.AUTH_TRUSTED_PROXY_IPS || "").split(",").map((x) => x.trim()).filter(Boolean);
const DB_SWITCH_RESTART_CMD = process.env.DB_SWITCH_RESTART_CMD || "";
const DB_SWITCH_POSTGRES_UP_CMD = process.env.DB_SWITCH_POSTGRES_UP_CMD || "";
const DB_SWITCH_DUMP_DIR = process.env.DB_SWITCH_DUMP_DIR || "/data/db-switch";
const DB_SWITCH_AUDIT_LOG = process.env.DB_SWITCH_AUDIT_LOG || "/data/db-switch/switch-audit.log";
const APP_MODE = String(process.env.APP_MODE || "info").toLowerCase();
const ADVANCED_DEBUG_TTL_MINUTES = Number(process.env.ADVANCED_DEBUG_TTL_MINUTES || 30);
const CRASH_REPORTS_DIR = process.env.CRASH_REPORTS_DIR || "/data/crash-reports";
const CRASH_ALERT_EMAILS = String(process.env.CRASH_ALERT_EMAILS || "").split(",").map((x) => x.trim()).filter(Boolean);
let currentAppMode = APP_MODE;

if (AUTH_TRUST_PROXY) {
  app.set("trust proxy", true);
}

if (currentAppMode === "advanced-debug") {
  logger.warn("advanced_debug_enabled", {
    ttlMinutes: ADVANCED_DEBUG_TTL_MINUTES,
    warning: "ADVANCED DEBUG ACTIVE"
  });
}

function setStartupPhase(phase) {
  startupPhase = phase;
}

const crashHandler = new CrashHandler({
  getRepo: () => repo,
  getSmtpService: () => smtpService,
  getBuildInfo: () => BUILD_INFO,
  getStartupPhase: () => startupPhase,
  getAppMode: () => currentAppMode,
  getAdminEmails: () => Array.from(new Set([OWNER_EMAIL, ...CRASH_ALERT_EMAILS].filter(Boolean))),
  crashDir: CRASH_REPORTS_DIR,
  recoveryPort: Number(PORT)
});

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

async function resolveRequestActor(req, res, next) {
  req.actor = await resolveActor({
    req,
    repo,
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

function setSessionCookie(res, token, expiresAt) {
  const expiresDate = new Date(expiresAt || Date.now() + SESSION_TTL_MS);
  const parts = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`,
    "HttpOnly",
    "Path=/",
    `Max-Age=${Math.floor(Math.max(expiresDate.getTime() - Date.now(), 1) / 1000)}`,
    `Expires=${expiresDate.toUTCString()}`,
    "SameSite=Lax"
  ];
  if (String(process.env.NODE_ENV || "").toLowerCase() === "production") {
    parts.push("Secure");
  }
  res.setHeader("Set-Cookie", parts.join("; "));
}

function clearSessionCookie(res) {
  const parts = [
    `${SESSION_COOKIE_NAME}=`,
    "HttpOnly",
    "Path=/",
    "Max-Age=0",
    "Expires=Thu, 01 Jan 1970 00:00:00 GMT",
    "SameSite=Lax"
  ];
  if (String(process.env.NODE_ENV || "").toLowerCase() === "production") {
    parts.push("Secure");
  }
  res.setHeader("Set-Cookie", parts.join("; "));
}

function safeJsonStringify(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return "__serialization_error__";
  }
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
const authLimiter = createRateLimiter({ windowMs: 10 * 60_000, max: 30 });

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

async function generateTasks(level, count, contentMode, language = "en") {
  const tasks = [];

  const level2PackItems = contentMode === "vocab" ? await repo.getPublishedPackItems({ language, type: "level2" }) : [];
  const level3PackItems = contentMode === "vocab" ? await repo.getPublishedPackItems({ language, type: "level3" }) : [];
  const sentencePackItems = contentMode === "vocab" ? await repo.getPublishedPackItems({ language, type: "sentence_words" }) : [];

  const useRuDefaults = language === "ru";
  const level2Words = level2PackItems.length
    ? level2PackItems.map((row) => row.text)
    : (useRuDefaults ? defaults.level2WordsRu : defaults.level2Words);
  const level3Words = level3PackItems.length
    ? level3PackItems.map((row) => row.text)
    : (useRuDefaults ? defaults.level3WordsRu : defaults.level3Words);
  const sentenceWords = sentencePackItems.length
    ? sentencePackItems.map((row) => row.text)
    : (useRuDefaults ? defaults.sentenceWordsRu : defaults.sentenceWords);

  if (level === 1) {
    for (let i = 0; i < count; i++) {
      const pool = [...(language === "ru" ? defaults.lettersRu : defaults.letters), ...defaults.digits];
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

async function verifyGoogleCredential(idToken) {
  if (!GOOGLE_CLIENT_ID) throw new Error("Google auth is not configured");
  // SECURITY: verify token signature and audience server-side before trusting claims.
  const { OAuth2Client } = require("google-auth-library");
  const client = new OAuth2Client(GOOGLE_CLIENT_ID);
  const ticket = await client.verifyIdToken({
    idToken,
    audience: GOOGLE_CLIENT_ID
  });
  return ticket.getPayload();
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
  res.json({ ok: true, service: "ktrain", driver: activeDriver, maintenanceMode, startupReady, appMode: currentAppMode, build: BUILD_INFO });
});

app.get("/readyz", async (req, res) => {
  if (!startupReady) {
    return res.status(503).json({ ok: false, ready: false, error: "Startup not complete", phase: startupPhase });
  }
  try {
    await repo.ping();
    res.json({ ok: true, ready: true, driver: activeDriver });
  } catch (err) {
    res.status(503).json({ ok: false, ready: false, error: "DB not reachable" });
  }
});

app.get("/api/health", (req, res) => {
  res.json({ ok: true, driver: activeDriver, dbDriverEnv: DB_DRIVER_ENV, startupReady, appMode: currentAppMode, build: BUILD_INFO });
});

app.get("/api/public/session", (req, res) => {
  const role = normalizeRole(req.actor?.role || Roles.GUEST);
  res.json({ ok: true, isAdmin: role === Roles.ADMIN || role === Roles.OWNER, role, actor: req.actor || null });
});

app.get("/api/public/version", (req, res) => {
  res.json({
    ok: true,
    version: BUILD_INFO.version,
    build: BUILD_INFO.build,
    commit: BUILD_INFO.commit,
    appMode: currentAppMode,
    buildTime: process.env.APP_BUILD_TIME || null,
    githubUrl: process.env.APP_GITHUB_URL || "https://github.com/viktordrukker/ktrain",
    website: "https://thedrukkers.com",
    contact: "mailto:vdrukker@thedrukkers.com"
  });
});

app.get("/api/auth/providers", withAsync(async (req, res) => {
  const emailSettings = await smtpService.getEmailSettings();
  const passwordResetEnabled = Boolean(
    emailSettings.host && emailSettings.username && emailSettings.password && emailSettings.fromAddress
  );
  res.json({
    ok: true,
    google: { enabled: Boolean(GOOGLE_CLIENT_ID), clientId: GOOGLE_CLIENT_ID || null },
    password: { enabled: true, resetEnabled: passwordResetEnabled }
  });
}));

app.get("/api/setup/status", withAsync(async (req, res) => {
  let dbOk = false;
  try {
    await repo.ping();
    dbOk = true;
  } catch {
    dbOk = false;
  }
  const owner = dbOk ? await repo.getOwnerUser() : null;
  const email = dbOk ? await smtpService.getEmailSettings() : null;
  const wizard = dbOk
    ? await configStore.get("app.wizard", { scope: "global", scopeId: "global", fallback: { completedAt: null, schemaVersion: 1 } })
    : { completedAt: null, schemaVersion: 1 };
  res.json({
    ok: true,
    wizardCompleted: Boolean(wizard?.completedAt),
    steps: {
      database: { ready: dbOk },
      smtp: { ready: Boolean(email?.host && email?.username && email?.fromAddress) },
      adminUser: { ready: Boolean(owner) },
      googleAuth: { ready: Boolean(GOOGLE_CLIENT_ID) }
    }
  });
}));

app.post("/api/setup/complete", requirePermission(Permissions.ADMIN_CONFIG_MANAGE), adminLimiter, withAsync(async (req, res) => {
  await configStore.setSafe("app.wizard", {
    completedAt: new Date().toISOString(),
    schemaVersion: 1
  }, { scope: "global", scopeId: "global", updatedBy: req.actor?.externalSubject || "admin" });
  await audit(req, "setup.complete", "wizard", "app");
  res.json({ ok: true });
}));

async function issueSessionForUser(req, res, user, auditAction) {
  // SECURITY: rotate existing sessions so stolen old cookies stop working after login.
  await repo.revokeAuthSessionsForUser(user.id);
  const session = await createAuthSession(repo, user, { userAgent: req.headers["user-agent"], ip: req.ip });
  setSessionCookie(res, session.token, session.expiresAt);
  if (auditAction) {
    await audit(req, auditAction, "user", String(user.id), { email: user.email });
  }
}

function genericAuthError() {
  return new AppError("Invalid email or password", { status: 401, code: "AUTH_INVALID", expose: true });
}

app.post("/api/auth/google", authLimiter, withAsync(async (req, res) => {
  const credential = asString(req.body?.credential || "", { min: 32, max: 8000, field: "credential" });
  const payload = await verifyGoogleCredential(credential);
  const email = payload.email;
  if (!email) throw badRequest("Google account email is required");
  let user = await getOrCreateUserByEmail(repo, email, Roles.USER);
  await repo.upsertAuthIdentity({
    userId: user.id,
    provider: "google",
    providerSubject: String(payload.sub || ""),
    passwordHash: null
  });
  await repo.updateUserProfile(user.id, { displayName: payload.name || user.displayName, avatarUrl: payload.picture || "" });
  await repo.touchUserLogin(user.id);
  user = await repo.findUserById(user.id);
  await issueSessionForUser(req, res, user, "auth.google.login");
  res.json({
    ok: true,
    user: {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      avatarUrl: user.avatarUrl || payload.picture || "",
      role: user.role
    }
  });
}));

app.post("/api/auth/register", authLimiter, withAsync(async (req, res) => {
  const email = normalizeEmail(asString(req.body?.email || "", { min: 5, max: 255, field: "email" }));
  const displayName = asString(req.body?.displayName || email.split("@")[0] || "Player", { min: 1, max: 64, field: "displayName" });
  const password = asString(req.body?.password || "", { min: 10, max: 128, field: "password" });
  const passwordPolicy = validatePasswordPolicy(password);
  if (!passwordPolicy.ok) throw badRequest(passwordPolicy.message);

  const existing = await repo.findUserByEmail(email);
  if (existing) {
    throw new AppError("Email already in use", { status: 409, code: "EMAIL_EXISTS", expose: true });
  }
  const user = await repo.createUser({
    externalSubject: `password:${email}`,
    email,
    displayName,
    role: Roles.USER
  });
  const passwordHash = await hashPassword(password);
  await upsertPasswordIdentity(repo, user.id, passwordHash);
  await repo.touchUserLogin(user.id);
  const fresh = await repo.findUserById(user.id);
  await issueSessionForUser(req, res, fresh, "auth.password.register");
  res.status(201).json({ ok: true, user: { id: fresh.id, email: fresh.email, displayName: fresh.displayName, avatarUrl: fresh.avatarUrl || "", role: fresh.role } });
}));

app.post("/api/auth/login", authLimiter, withAsync(async (req, res) => {
  const email = normalizeEmail(asString(req.body?.email || "", { min: 5, max: 255, field: "email" }));
  const password = asString(req.body?.password || "", { min: 1, max: 128, field: "password" });
  const identity = await getPasswordIdentityByEmail(repo, email);
  const ok = await verifyPassword(password, identity?.passwordhash || identity?.passwordHash || "");
  if (!identity || !ok) throw genericAuthError();
  const user = await repo.findUserById(identity.userid || identity.userId);
  if (!user || Number(user.isActive) !== 1) throw genericAuthError();
  await repo.touchUserLogin(user.id);
  await issueSessionForUser(req, res, user, "auth.password.login");
  res.json({ ok: true, user: { id: user.id, email: user.email, displayName: user.displayName, avatarUrl: user.avatarUrl || "", role: user.role } });
}));

app.post("/api/auth/password-reset/request", authLimiter, withAsync(async (req, res) => {
  const email = normalizeEmail(asString(req.body?.email || "", { min: 5, max: 255, field: "email" }));
  const user = await repo.findUserByEmail(email);
  const responseMessage = "If the account exists, a password reset email has been sent.";
  if (!user) {
    await audit(req, "auth.password.reset.request", "email", email, { result: "masked_no_user" });
    return res.json({ ok: true, message: responseMessage });
  }
  try {
    const token = await createPasswordReset(repo, user.id, { ip: req.ip });
    const url = `${APP_BASE_URL}/?reset_token=${encodeURIComponent(token.token)}`;
    await smtpService.send({
      to: email,
      subject: "Reset your KTrain password",
      text: `Reset your password using this link (expires in 1 hour): ${url}`,
      html: `<p>Reset your password using this link (expires in 1 hour):</p><p><a href="${url}">${url}</a></p>`
    });
    await audit(req, "auth.password.reset.request", "user", String(user.id), { email, sent: true });
  } catch {
    await audit(req, "auth.password.reset.request", "user", String(user.id), { email, sent: false });
  }
  return res.json({ ok: true, message: responseMessage });
}));

app.post("/api/auth/password-reset/confirm", authLimiter, withAsync(async (req, res) => {
  const token = asString(req.body?.token || "", { min: 20, max: 255, field: "token" });
  const password = asString(req.body?.password || "", { min: 10, max: 128, field: "password" });
  const passwordPolicy = validatePasswordPolicy(password);
  if (!passwordPolicy.ok) throw badRequest(passwordPolicy.message);
  const row = await consumePasswordReset(repo, token);
  if (!row) throw badRequest("Invalid or expired reset token");
  const userId = row.userid || row.userId;
  const passwordHash = await hashPassword(password);
  await upsertPasswordIdentity(repo, userId, passwordHash);
  await repo.revokeAuthSessionsForUser(userId);
  const user = await repo.findUserById(userId);
  await repo.touchUserLogin(userId);
  await issueSessionForUser(req, res, user, "auth.password.reset.success");
  res.json({ ok: true });
}));

app.post("/api/auth/logout", withAsync(async (req, res) => {
  const authHeader = String(req.headers.authorization || "");
  const cookieHeader = String(req.headers.cookie || "");
  if (authHeader.startsWith("Bearer ")) {
    const tokenHash = hashToken(authHeader.slice("Bearer ".length).trim());
    await repo.revokeAuthSession(tokenHash);
  }
  const cookieToken = cookieHeader
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${SESSION_COOKIE_NAME}=`));
  if (cookieToken) {
    const raw = decodeURIComponent(cookieToken.split("=").slice(1).join("=") || "");
    if (raw) await repo.revokeAuthSession(hashToken(raw));
  }
  clearSessionCookie(res);
  res.json({ ok: true });
}));

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

app.get("/api/user/profile", requirePermission(Permissions.SESSION_READ), withAsync(async (req, res) => {
  if (!req.actor?.isAuthenticated) {
    return res.json({ ok: true, profile: null });
  }
  const dbUser = await repo.findUserById(req.actor.id);
  res.json({
    ok: true,
    profile: {
      id: req.actor.id,
      email: req.actor.email,
      displayName: req.actor.displayName,
      role: req.actor.role,
      avatarUrl: dbUser?.avatarUrl || req.actor.avatarUrl || ""
    }
  });
}));

app.put("/api/user/profile", requirePermission(Permissions.SESSION_READ), withAsync(async (req, res) => {
  if (!req.actor?.isAuthenticated) throw new AppError("Authentication required", { status: 401, code: "UNAUTHORIZED", expose: true });
  const displayName = asString(req.body?.displayName || "", { min: 1, max: 64, field: "displayName" });
  const avatarUrl = String(req.body?.avatarUrl || "");
  const user = await repo.updateUserProfile(req.actor.id, { displayName, avatarUrl });
  await audit(req, "user.profile.update", "user", String(req.actor.id));
  res.json({ ok: true, profile: user });
}));

app.get("/api/user/openai-key/status", requirePermission(Permissions.SESSION_READ), withAsync(async (req, res) => {
  if (!req.actor?.isAuthenticated) return res.json({ ok: true, configured: false });
  const existing = await repo.getUserSecret(req.actor.id, "openai_api_key");
  res.json({ ok: true, configured: Boolean(existing) });
}));

app.put("/api/user/openai-key", requirePermission(Permissions.SESSION_READ), withAsync(async (req, res) => {
  if (!req.actor?.isAuthenticated) throw new AppError("Authentication required", { status: 401, code: "UNAUTHORIZED", expose: true });
  const apiKey = asString(req.body?.apiKey || "", { min: 20, max: 200, field: "apiKey" });
  await storeOpenAIKeyForActor(req.actor, apiKey);
  await audit(req, "user.openai_key.update", "user", String(req.actor.id));
  res.json({ ok: true });
}));

app.get("/api/user/history", requirePermission(Permissions.SESSION_READ), withAsync(async (req, res) => {
  if (!req.actor?.isAuthenticated) return res.json({ ok: true, entries: [] });
  const entries = await repo.queryLeaderboard({ onlyAuthorized: true });
  const own = entries.filter((row) => Number(row.userid || row.userId) === Number(req.actor.id));
  res.json({ ok: true, entries: own });
}));

app.post("/api/tasks/generate", requirePermission(Permissions.TASKS_GENERATE), requireNotMaintenance, generationLimiter, withAsync(async (req, res) => {
  const body = requireObject(req.body || {}, "body");
  const actorIsAuthorized = Boolean(req.actor?.isAuthenticated);
  const maxLevel = actorIsAuthorized ? 5 : 3;
  const safeLevel = asNumber(body.level, { min: 1, max: maxLevel, field: "level" });
  const safeCount = asNumber(body.count ?? 10, { min: 5, max: 100, field: "count" });
  const safeContentMode = body.contentMode === "vocab" ? "vocab" : "default";
  const requestedLanguage = String(body.language || "en").toLowerCase();
  const languages = await repo.listPublishedLanguagesByType(safeLevel === 2 ? "level2" : safeLevel === 3 ? "level3" : "sentence_words");
  let fallbackNotice = null;
  let language = requestedLanguage;
  if (!languages.includes(language)) {
    if (requestedLanguage === "ru" && languages.includes("en")) {
      language = "en";
      fallbackNotice = "Russian pack missing, using English";
    } else if (languages.length > 0) {
      language = languages[0];
    } else {
      language = requestedLanguage === "ru" ? "ru" : "en";
    }
  }
  const tasks = await generateTasks(safeLevel, safeCount, safeContentMode, language);
  res.json({ tasks, language, fallbackNotice, safeDefaultsApplied: !actorIsAuthorized });
}));

app.post("/api/results", requirePermission(Permissions.RESULTS_WRITE), requireNotMaintenance, resultsLimiter, withAsync(async (req, res) => {
  const body = requireObject(req.body || {}, "result");
  if (body.mode && body.mode !== "contest") return res.json({ ok: true, saved: false });
  if (!req.actor?.isAuthenticated) {
    // SECURITY: global leaderboard contains authorized players only.
    return res.json({ ok: true, saved: false, reason: "auth_required_for_global_leaderboard" });
  }

  const createdAt = new Date().toISOString();
  const contestType = body.contestType === "tasks" ? "tasks" : "time";
  const level = clampNumber(body.level, 1, 5, 1);
  const contentMode = body.contentMode === "vocab" ? "vocab" : "default";
  const duration = contestType === "time" ? clampNumber(body.duration, 30, 120, 60) : null;
  const taskTarget = contestType === "tasks" ? clampNumber(body.taskTarget, 10, 50, 20) : null;
  const accuracy = clampNumber(body.accuracy, 0, 100, 0);

  await repo.insertLeaderboard({
    playerName: cleanName(body.playerName || req.actor.displayName || "Player"),
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
    maxStreak: clampNumber(body.maxStreak, 0, 100_000, 0),
    userId: req.actor.id,
    isGuest: 0,
    language: String(body.language || "en").toLowerCase(),
    displayName: req.actor.displayName || cleanName(body.playerName || "Player"),
    avatarUrl: body.avatarUrl || null
  });

  res.json({ ok: true, saved: true });
}));

app.get("/api/leaderboard", requirePermission(Permissions.LEADERBOARD_READ), withAsync(async (req, res) => {
  const entries = await repo.queryLeaderboard({ ...(req.query || {}), onlyAuthorized: true });
  let myRank = null;
  if (req.actor?.isAuthenticated) {
    const idx = entries.findIndex((entry) => Number(entry.userid || entry.userId) === Number(req.actor.id));
    if (idx >= 0) myRank = idx + 1;
  }
  res.json({ entries, myRank });
}));

app.get("/api/packs/languages", requirePermission(Permissions.TASKS_GENERATE), withAsync(async (req, res) => {
  const level = asNumber(req.query.level || 2, { min: 1, max: 5, field: "level" });
  const type = level === 2 ? "level2" : level === 3 ? "level3" : "sentence_words";
  const languages = await repo.listPublishedLanguagesByType(type);
  res.json({ ok: true, level, type, languages });
}));

app.get("/api/packs/items", requirePermission(Permissions.TASKS_GENERATE), withAsync(async (req, res) => {
  const language = asString(req.query.language || "en", { min: 2, max: 10, field: "language" }).toLowerCase();
  const type = asEnum(req.query.type || "level2", ["level2", "level3", "sentence_words"], "type");
  const items = await repo.getPublishedPackItems({ language, type });
  res.json({ ok: true, items });
}));

app.get("/api/admin/language-packs", requirePermission(Permissions.VOCAB_MANAGE), adminLimiter, withAsync(async (req, res) => {
  const filters = {
    language: req.query.language ? String(req.query.language).toLowerCase() : undefined,
    type: req.query.type ? String(req.query.type) : undefined,
    status: req.query.status ? String(req.query.status).toUpperCase() : undefined
  };
  const packs = await repo.listLanguagePacks(filters);
  const enriched = await Promise.all(packs.map(async (pack) => ({
    ...pack,
    items: await repo.getLanguagePackItems(pack.id)
  })));
  res.json({ ok: true, packs: enriched });
}));

app.post("/api/admin/language-packs", requirePermission(Permissions.VOCAB_MANAGE), adminLimiter, withAsync(async (req, res) => {
  const language = asString(req.body?.language || "en", { min: 2, max: 10, field: "language" }).toLowerCase();
  const type = asEnum(req.body?.type || "level2", ["level2", "level3", "sentence_words"], "type");
  const topic = String(req.body?.topic || "general");
  const status = asEnum(String(req.body?.status || "DRAFT").toUpperCase(), ["DRAFT", "PUBLISHED", "ARCHIVED"], "status");
  const items = parseJsonArrayOfStrings(req.body?.items || [], "items").map((text) => ({ text, difficulty: null, metadataJson: {} }));
  const packId = await repo.createLanguagePack({ language, type, topic, status, createdBy: req.actor?.id || null });
  await repo.replaceLanguagePackItems(packId, items);
  await audit(req, "language_pack.create", "pack", String(packId), { language, type, status, count: items.length });
  res.json({ ok: true, packId });
}));

app.put("/api/admin/language-packs/:id", requirePermission(Permissions.VOCAB_MANAGE), adminLimiter, withAsync(async (req, res) => {
  const id = asNumber(req.params.id, { min: 1, field: "id" });
  const status = req.body?.status ? asEnum(String(req.body.status).toUpperCase(), ["DRAFT", "PUBLISHED", "ARCHIVED"], "status") : undefined;
  const topic = req.body?.topic ? String(req.body.topic) : undefined;
  await repo.updateLanguagePack(id, { topic, status });
  if (Array.isArray(req.body?.items)) {
    const items = parseJsonArrayOfStrings(req.body.items, "items").map((text) => ({ text, difficulty: null, metadataJson: {} }));
    await repo.replaceLanguagePackItems(id, items);
  }
  await audit(req, "language_pack.update", "pack", String(id), { status, topic });
  res.json({ ok: true });
}));

app.get("/api/admin/language-packs/export", requirePermission(Permissions.VOCAB_MANAGE), adminLimiter, withAsync(async (req, res) => {
  const packs = await repo.listLanguagePacks({});
  const rows = await Promise.all(packs.map(async (pack) => ({
    ...pack,
    items: (await repo.getLanguagePackItems(pack.id)).map((item) => item.text)
  })));
  res.json({ ok: true, packs: rows });
}));

app.post("/api/admin/language-packs/import", requirePermission(Permissions.VOCAB_MANAGE), adminLimiter, withAsync(async (req, res) => {
  const packs = Array.isArray(req.body?.packs) ? req.body.packs : [];
  for (const pack of packs) {
    const language = asString(pack.language || "en", { min: 2, max: 10, field: "language" }).toLowerCase();
    const type = asEnum(pack.type || "level2", ["level2", "level3", "sentence_words"], "type");
    const topic = String(pack.topic || "imported");
    const status = asEnum(String(pack.status || "DRAFT").toUpperCase(), ["DRAFT", "PUBLISHED", "ARCHIVED"], "status");
    const items = parseJsonArrayOfStrings(pack.items || [], "items").map((text) => ({ text, difficulty: null, metadataJson: { source: "import" } }));
    const packId = await repo.createLanguagePack({ language, type, topic, status, createdBy: req.actor?.id || null });
    await repo.replaceLanguagePackItems(packId, items);
  }
  await audit(req, "language_pack.import", "pack", "bulk", { count: packs.length });
  res.json({ ok: true, imported: packs.length });
}));

app.post("/api/admin/language-packs/generate", requirePermission(Permissions.VOCAB_MANAGE), adminLimiter, generationLimiter, withAsync(async (req, res) => {
  if (!req.actor?.isAuthenticated) throw badRequest("Authentication required");
  const existing = await repo.getUserSecret(req.actor.id, "openai_api_key");
  if (!existing) throw badRequest("OpenAI key is required for generation");
  const apiKey = await getOpenAIKeyForActor(req.actor);
  const language = asString(req.body?.language || "en", { min: 2, max: 10, field: "language" }).toLowerCase();
  const type = asEnum(req.body?.type || "level2", ["level2", "level3", "sentence_words"], "type");
  const count = asNumber(req.body?.count || 30, { min: 5, max: 200, field: "count" });
  const topic = String(req.body?.topic || "general toddler-safe learning");
  const prompt = strictPrompt({ language, type, count, topic });
  const output = await callOpenAI({ apiKey, prompt });
  const parsed = JSON.parse(output);
  const items = parseJsonArrayOfStrings(parsed.items || [], "items", 500);
  const packId = await repo.createLanguagePack({ language, type, topic, status: "DRAFT", createdBy: req.actor.id });
  await repo.replaceLanguagePackItems(packId, items.map((text) => ({ text, difficulty: null, metadataJson: { source: "openai" } })));
  await audit(req, "language_pack.generate", "pack", String(packId), { language, type, count: items.length });
  res.json({ ok: true, packId, status: "DRAFT", count: items.length });
}));

app.get("/api/live/stats", requirePermission(Permissions.TASKS_GENERATE), withAsync(async (req, res) => {
  await repo.cleanupActiveSessions(120);
  const stats = await repo.getActiveSessionStats(120);
  res.json({ ok: true, stats });
}));

app.get("/api/admin/live/stats", requirePermission(Permissions.ADMIN_DIAGNOSTICS_READ), adminLimiter, withAsync(async (req, res) => {
  await repo.cleanupActiveSessions(120);
  const stats = await repo.getActiveSessionStats(120);
  res.json({ ok: true, stats });
}));

app.post("/api/live/heartbeat", requirePermission(Permissions.TASKS_GENERATE), withAsync(async (req, res) => {
  const sessionId = asString(req.body?.sessionId || "", { min: 8, max: 128, field: "sessionId" });
  const mode = asEnum(req.body?.mode || "learning", ["learning", "contest"], "mode");
  await repo.upsertActiveSession({
    sessionId,
    userId: req.actor?.isAuthenticated ? req.actor.id : null,
    mode,
    isAuthorized: Boolean(req.actor?.isAuthenticated)
  });
  await repo.cleanupActiveSessions(120);
  const stats = await repo.getActiveSessionStats(120);
  res.json({ ok: true, stats });
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

app.get("/api/admin/service-settings", requirePermission(Permissions.ADMIN_CONFIG_MANAGE), adminLimiter, withAsync(async (req, res) => {
  const email = await smtpService.getEmailSettings();
  res.json({
    ok: true,
    settings: {
      email: {
        host: email.host,
        port: email.port,
        secure: email.secure,
        username: email.username,
        fromAddress: email.fromAddress,
        fromName: email.fromName,
        hasPassword: Boolean(email.password)
      },
      db: {
        activeDriver,
        dbConfig: resolveDbConfig()
      }
    }
  });
}));

app.post("/api/admin/service-settings/email", requirePermission(Permissions.ADMIN_CONFIG_MANAGE), adminLimiter, withAsync(async (req, res) => {
  const payload = requireObject(req.body || {}, "email settings");
  await smtpService.saveEmailSettings(payload, req.actor?.externalSubject || "admin");
  const saved = await smtpService.getEmailSettings();
  await audit(req, "service_settings.email.update", "email", "smtp");
  res.json({ ok: true, settings: { ...saved, hasPassword: Boolean(saved.password) } });
}));

app.post("/api/admin/service-settings/email/test", requirePermission(Permissions.ADMIN_CONFIG_MANAGE), adminLimiter, withAsync(async (req, res) => {
  const to = asString(req.body?.to || req.actor?.email || "", { min: 5, max: 255, field: "to" });
  await smtpService.send({
    to,
    subject: "KTrain SMTP test",
    text: "SMTP test message from KTrain admin settings.",
    html: "<p>SMTP test message from KTrain admin settings.</p>"
  });
  await audit(req, "service_settings.email.test", "email", to);
  res.json({ ok: true });
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

app.post("/api/admin/config/export", requirePermission(Permissions.ADMIN_CONFIG_PORTABILITY), adminLimiter, withAsync(async (req, res) => {
  const includeSecrets = Boolean(req.body?.includeSecrets);
  const rows = await configStore.exportSafeConfig();
  const runtime = readRuntimeConfig();
  const languagePackMeta = (await repo.listLanguagePacks({})).map((p) => ({
    id: p.id,
    language: p.language,
    type: p.type,
    status: p.status,
    topic: p.topic,
    updatedAt: p.updatedAt || p.updatedat
  }));
  const metadata = {
    appVersion: BUILD_INFO.version,
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    build: BUILD_INFO.build,
    commit: BUILD_INFO.commit
  };
  let secrets = [];
  if (includeSecrets) {
    const smtpSecret = await repo.getSystemSecret("smtp.password");
    if (smtpSecret) {
      secrets.push({
        key: "smtp.password",
        ciphertext: smtpSecret.ciphertext,
        iv: smtpSecret.iv,
        authTag: smtpSecret.authtag || smtpSecret.authTag
      });
    }
  }
  res.json({
    ok: true,
    metadata,
    config: rows,
    runtime: { activeDriver: runtime.activeDriver, dbConfigPresent: Boolean(runtime.dbConfig) },
    languagePackMeta,
    authProviderMeta: { googleEnabled: Boolean(GOOGLE_CLIENT_ID), passwordEnabled: true },
    smtpMeta: {
      configured: Boolean((await smtpService.getEmailSettings()).host)
    },
    secrets: includeSecrets ? secrets : []
  });
}));

app.post("/api/admin/config/import-preview", requirePermission(Permissions.ADMIN_CONFIG_PORTABILITY), adminLimiter, withAsync(async (req, res) => {
  const payload = requireObject(req.body || {}, "payload");
  const incoming = Array.isArray(payload.config) ? payload.config : [];
  const current = await configStore.exportSafeConfig();
  const mapCurrent = new Map(current.map((row) => [`${row.scope}:${row.scopeId}:${row.key}`, row]));
  const diff = incoming.map((row) => {
    const k = `${row.scope || "global"}:${row.scopeId || "global"}:${row.key}`;
    const prev = mapCurrent.get(k);
    return {
      key: row.key,
      scope: row.scope || "global",
      scopeId: row.scopeId || "global",
      changed: safeJsonStringify(prev?.valueJson) !== safeJsonStringify(row.valueJson),
      previousValue: prev ? prev.valueJson : null,
      nextValue: row.valueJson
    };
  });
  res.json({ ok: true, compatible: true, diff });
}));

app.post("/api/admin/config/import-apply", requirePermission(Permissions.ADMIN_CONFIG_PORTABILITY), adminLimiter, withAsync(async (req, res) => {
  const payload = requireObject(req.body || {}, "payload");
  const rows = Array.isArray(payload.config) ? payload.config : [];
  const mode = asEnum(payload.mode || "replace", ["replace", "merge"], "mode");
  const partialKeys = Array.isArray(payload.partialKeys) ? new Set(payload.partialKeys.map((x) => String(x))) : null;

  let applyRows = rows;
  if (partialKeys && partialKeys.size > 0) {
    applyRows = rows.filter((row) => partialKeys.has(String(row.key)));
  }
  if (mode === "replace") {
    const existing = await configStore.exportSafeConfig();
    for (const row of existing) {
      if (!applyRows.find((r) => r.key === row.key && (r.scope || "global") === row.scope && (r.scopeId || "global") === row.scopeId)) {
        await repo.setConfig(row.key, row.scope, row.scopeId, row.valueJson, req.actor?.externalSubject || "admin");
      }
    }
  }
  await configStore.importSafeConfig(applyRows, req.actor?.externalSubject || "admin");
  if (Array.isArray(payload.secrets)) {
    for (const secret of payload.secrets) {
      if (secret.key === "smtp.password" && secret.ciphertext && secret.iv && secret.authTag) {
        await repo.setSystemSecret("smtp.password", {
          ciphertext: secret.ciphertext,
          iv: secret.iv,
          authTag: secret.authTag
        }, req.actor?.externalSubject || "admin");
      }
    }
  }
  await audit(req, "config.import.apply", "config", "global", { count: applyRows.length, mode });
  res.json({ ok: true, applied: applyRows.length, mode });
}));

app.post("/api/admin/runtime/mode", requirePermission(Permissions.ADMIN_CONFIG_MANAGE), adminLimiter, withAsync(async (req, res) => {
  const mode = asEnum(String(req.body?.mode || "").toLowerCase(), ["info", "debug", "advanced-debug"], "mode");
  const reason = asString(req.body?.reason || "manual change", { min: 3, max: 240, field: "reason" });
  let advancedDebugExpiresAt = null;
  if (mode === "advanced-debug") {
    advancedDebugExpiresAt = new Date(Date.now() + ADVANCED_DEBUG_TTL_MINUTES * 60 * 1000).toISOString();
  }
  await configStore.setSafe("app.runtime", {
    mode,
    advancedDebugExpiresAt
  }, { scope: "global", scopeId: "global", updatedBy: req.actor?.externalSubject || "admin" });
  const previous = currentAppMode;
  currentAppMode = mode;
  await audit(req, "runtime.mode.change", "runtime_mode", mode, { from: previous, to: mode, reason, advancedDebugExpiresAt });
  res.json({ ok: true, mode, previous, advancedDebugExpiresAt });
}));

app.get("/api/admin/language/diagnostics", requirePermission(Permissions.ADMIN_DIAGNOSTICS_READ), adminLimiter, withAsync(async (req, res) => {
  const level = asNumber(req.query.level || 2, { min: 1, max: 5, field: "level" });
  const requestedLanguage = asString(req.query.language || "en", { min: 2, max: 10, field: "language" }).toLowerCase();
  const type = level === 2 ? "level2" : level === 3 ? "level3" : "sentence_words";
  const languages = await repo.listPublishedLanguagesByType(type);
  const language = languages.includes(requestedLanguage) ? requestedLanguage : (languages[0] || requestedLanguage);
  const pack = (await repo.listLanguagePacks({ language, type, status: "PUBLISHED" }))[0] || null;
  const sample = (await generateTasks(level, 1, "vocab", language))[0] || null;
  res.json({
    ok: true,
    requestedLanguage,
    currentLanguage: language,
    packUsed: pack ? { id: pack.id, language: pack.language, type: pack.type, topic: pack.topic } : null,
    preview: sample
  });
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

app.get("/api/admin/crashes", requirePermission(Permissions.ADMIN_DIAGNOSTICS_READ), adminLimiter, withAsync(async (req, res) => {
  const limit = asNumber(req.query.limit || 50, { min: 1, max: 500, field: "limit" });
  const unresolvedOnly = String(req.query.unresolvedOnly || "false") === "true";
  const crashes = await repo.listCrashEvents(limit, unresolvedOnly);
  const unresolvedCount = (await repo.listCrashEvents(500, true)).length;
  res.json({ ok: true, crashes, unresolvedCount });
}));

app.get("/api/admin/crashes/:id", requirePermission(Permissions.ADMIN_DIAGNOSTICS_READ), adminLimiter, withAsync(async (req, res) => {
  const id = asNumber(req.params.id, { min: 1, field: "id" });
  const crash = await repo.getCrashEventById(id);
  if (!crash) throw new AppError("Crash event not found", { status: 404, code: "NOT_FOUND", expose: true });
  res.json({ ok: true, crash });
}));

app.post("/api/admin/crashes/:id/ack", requirePermission(Permissions.ADMIN_DIAGNOSTICS_READ), adminLimiter, withAsync(async (req, res) => {
  const id = asNumber(req.params.id, { min: 1, field: "id" });
  const updated = await repo.acknowledgeCrashEvent(id, req.actor?.externalSubject || req.actor?.email || "admin");
  if (!updated) throw new AppError("Crash event not found", { status: 404, code: "NOT_FOUND", expose: true });
  await audit(req, "crash.acknowledge", "crash_event", String(id));
  res.json({ ok: true, crash: updated });
}));

const clientDist = path.join(__dirname, "../client/dist");
const indexHtml = path.join(clientDist, "index.html");
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get(["/admin*", "/settings-admin*"], (req, res, next) => {
    const role = normalizeRole(req.actor?.role || Roles.GUEST);
    if (![Roles.ADMIN, Roles.OWNER].includes(role)) return res.status(403).send("Not authorized. Sign in with an admin account.");
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
  const keys = new Set(existing.map((row) => row.key));
  if (!keys.has("app.features")) {
    await configStore.setSafe("app.features", { maintenanceMode: false }, { scope: "global", scopeId: "global", updatedBy: "bootstrap" });
  }
  if (!keys.has("contest.rules")) {
    await configStore.setSafe("contest.rules", { maxAllowedLevel: 5, durations: [30, 60, 120], taskTargets: [10, 20, 50] }, { scope: "global", scopeId: "global", updatedBy: "bootstrap" });
  }
  if (!keys.has("generator.defaults")) {
    await configStore.setSafe("generator.defaults", { openAiModel: OPENAI_MODEL, maxCount: 200 }, { scope: "global", scopeId: "global", updatedBy: "bootstrap" });
  }
  if (!keys.has("app.runtime")) {
    await configStore.setSafe("app.runtime", { mode: APP_MODE, advancedDebugExpiresAt: null }, { scope: "global", scopeId: "global", updatedBy: "bootstrap" });
  }
  if (!keys.has("app.about")) {
    await configStore.setSafe("app.about", {
      website: "https://thedrukkers.com",
      contact: "mailto:vdrukker@thedrukkers.com",
      githubUrl: process.env.APP_GITHUB_URL || "https://github.com/viktordrukker/ktrain"
    }, { scope: "global", scopeId: "global", updatedBy: "bootstrap" });
  }
  if (!keys.has("app.wizard")) {
    await configStore.setSafe("app.wizard", { completedAt: null, schemaVersion: 1 }, { scope: "global", scopeId: "global", updatedBy: "bootstrap" });
  }
}

async function start() {
  setStartupPhase("init_db");
  const dbState = await initDb();
  repo = dbState.adapter;
  activeDriver = dbState.driver;

  setStartupPhase("init_config_store");
  configStore = new ConfigStore({
    repo,
    ttlMs: Number(process.env.CONFIG_CACHE_TTL_MS || 5000)
  });

  setStartupPhase("init_encryption");
  encryptionService = new EncryptionService(process.env.KTRAIN_MASTER_KEY || "");
  smtpService = new SmtpService({ configStore, repo, encryptionService });

  setStartupPhase("owner_bootstrap");
  await ensureOwnerBootstrap();
  setStartupPhase("seed_runtime_config");
  await seedDefaultRuntimeConfig();
  const runtimeModeCfg = await configStore.get("app.runtime", {
    scope: "global",
    scopeId: "global",
    fallback: { mode: APP_MODE, advancedDebugExpiresAt: null }
  });
  currentAppMode = ["info", "debug", "advanced-debug"].includes(String(runtimeModeCfg?.mode || ""))
    ? String(runtimeModeCfg.mode)
    : APP_MODE;
  if (currentAppMode === "advanced-debug" && runtimeModeCfg?.advancedDebugExpiresAt) {
    const expiresAt = Date.parse(runtimeModeCfg.advancedDebugExpiresAt);
    if (Number.isFinite(expiresAt) && expiresAt <= Date.now()) {
      currentAppMode = "debug";
      await configStore.setSafe("app.runtime", { mode: "debug", advancedDebugExpiresAt: null }, {
        scope: "global",
        scopeId: "global",
        updatedBy: "system:auto-expire"
      });
    }
  }
  setStartupPhase("seed_language_packs");
  await seedBuiltinLanguagePacks(repo);

  setStartupPhase("startup_self_checks");
  startupSelfChecks = {
    configSchema: await checkConfigSchema(configStore),
    migrations: await checkMigrations(repo, activeDriver),
    indexes: await checkRequiredIndexes(repo),
    encryption: checkEncryption(encryptionService)
  };
  logger.info("startup_self_checks", startupSelfChecks);

  if (!startupSelfChecks.migrations.ok || !startupSelfChecks.indexes.ok) {
    throw new Error("Startup self-check failed: required migrations/indexes missing");
  }

  setInterval(() => {
    Promise.all([
      repo.cleanupActiveSessions(120),
      repo.cleanupAuthSessions()
    ]).catch((err) => logger.warn("background_cleanup_failed", { error: err }));
  }, 60 * 1000);

  if (currentAppMode === "advanced-debug") {
    setTimeout(() => {
      currentAppMode = "debug";
      configStore.setSafe("app.runtime", { mode: "debug", advancedDebugExpiresAt: null }, {
        scope: "global",
        scopeId: "global",
        updatedBy: "system:auto-expire"
      }).catch(() => null);
      logger.warn("advanced_debug_expired", { ttlMinutes: ADVANCED_DEBUG_TTL_MINUTES });
    }, ADVANCED_DEBUG_TTL_MINUTES * 60 * 1000);
  }

  setStartupPhase("http_listen");
  app.listen(PORT, () => {
    startupReady = true;
    setStartupPhase("ready");
    logger.info("server_started", { port: PORT, driver: activeDriver });
  });
}

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    await crashHandler.capture({
      type: "manual_termination",
      error: new Error(`Received ${signal}`),
      metadata: { signal }
    });
  } catch {
    // ignore capture failures during shutdown
  }
  try {
    if (repo?.close) await repo.close();
  } catch {
    // ignore
  }
  process.exit(0);
}

process.on("SIGTERM", () => { void shutdown("SIGTERM"); });
process.on("SIGINT", () => { void shutdown("SIGINT"); });

process.on("uncaughtException", (err) => {
  void crashHandler.capture({
    type: "runtime_fatal_exception",
    error: err,
    metadata: { phase: startupPhase }
  }).finally(() => process.exit(1));
});

process.on("unhandledRejection", (reason) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  void crashHandler.capture({
    type: "runtime_unhandled_rejection",
    error: err,
    metadata: { phase: startupPhase }
  }).finally(() => process.exit(1));
});

start().catch((err) => {
  startupReady = false;
  logger.error("server_start_failed", { error: err, phase: startupPhase });
  void crashHandler.capture({
    type: "startup_failure",
    error: err,
    metadata: { phase: startupPhase }
  }).then(() => {
    crashHandler.startRecoveryServer();
  });
});
