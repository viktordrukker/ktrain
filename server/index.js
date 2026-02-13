require("dotenv").config();

/**
 * K-TRAIN server entrypoint.
 *
 * Architecture notes:
 * - Bootstrap env is intentionally minimal (`KTRAIN_MASTER_KEY`, `KTRAIN_BOOTSTRAP_DB`).
 * - Operational configuration is DB-backed via `ConfigStore` and validated at runtime.
 * - Setup mode is state-derived from `ConfigStatus`; there is no static "wizard complete" truth.
 * - Sensitive values must never be logged in plaintext.
 */
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const path = require("path");
const fs = require("fs");
const { exec } = require("child_process");
const { promisify } = require("util");
const { randomUUID } = require("crypto");
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
const { computeConfigStatus } = require("./src/application/config-status");
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
let setupModeActive = false;
let configStatusSnapshot = null;
let configStatusExpiresAt = 0;
const OPENAI_EPHEMERAL_TTL_MS = 12 * 60 * 60 * 1000;
const openaiEphemeralKeys = new Map();
const defaultModeSessionState = new Map();
const defaultModeGenerationInFlight = new Map();
const DEFAULT_MODE_SESSION_TTL_MS = 2 * 60 * 60 * 1000;

const BUILD_INFO = {
  version: process.env.APP_VERSION || "0.0.0",
  build: process.env.APP_BUILD || "0",
  commit: process.env.APP_COMMIT || process.env.GIT_COMMIT || "unknown"
};

/**
 * Environment contract (runtime):
 * - REQUIRED: `KTRAIN_MASTER_KEY`
 * - REQUIRED for DB bootstrap/fallback: `KTRAIN_BOOTSTRAP_DB`
 * - Optional env values are boot defaults and may be superseded by DB config.
 *
 * SECURITY: treat env as bootstrap-only; do not assume env changes represent applied runtime config.
 */
const PORT = process.env.PORT || 3000;
const OWNER_EMAIL = process.env.OWNER_EMAIL || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const APP_BASE_URL = process.env.APP_BASE_URL || "http://localhost:3000";
const BOOTSTRAP_GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
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
app.use(withAsync(enforceSetupMode));

/**
 * Resolves the actor (user identity and role) for the current request.
 * @param {object} req - Express request object
 * @param {object} res - Express response object
 * @param {Function} next - Express next middleware function
 * @returns {Promise<void>}
 */
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

/**
 * Records an audit log entry for the current request.
 * @param {object} req - Express request object with actor and requestId
 * @param {string} action - The action being audited (e.g., "user.login", "settings.update")
 * @param {string} targetType - The type of resource being acted upon
 * @param {string|number|null} targetId - The ID of the resource being acted upon
 * @param {object|null} [metadata=null] - Additional metadata to include in the audit log
 * @returns {Promise<void>}
 */
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

/**
 * Computes and caches the current config status, determining if setup is required.
 * @param {object} [options] - Options object
 * @param {boolean} [options.force=false] - If true, bypass cache and recompute
 * @returns {Promise<object|null>} Config status snapshot or null if dependencies unavailable
 */
async function refreshConfigStatus({ force = false } = {}) {
  if (!repo || !configStore || !smtpService) return null;
  const now = Date.now();
  if (!force && configStatusSnapshot && configStatusExpiresAt > now) return configStatusSnapshot;
  const snapshot = await computeConfigStatus({
    repo,
    configStore,
    smtpService,
    activeDriver,
    maintenanceMode,
    migrationStatus: getMigrationStatus,
    googleClientIdFromEnv: BOOTSTRAP_GOOGLE_CLIENT_ID,
    openaiModel: OPENAI_MODEL
  });
  configStatusSnapshot = snapshot;
  configStatusExpiresAt = now + 3000;
  setupModeActive = snapshot.overall === "SETUP_REQUIRED";
  return snapshot;
}

/**
 * Setup mode route allowlist.
 *
 * WHY: when required config is missing/invalid we must block normal app behavior
 * and only expose safe remediation/status routes.
 */
function isSetupPathAllowed(req) {
  const p = req.path || "/";
  if (p === "/healthz" || p === "/readyz" || p === "/setup") return true;
  if (p.startsWith("/api/public/config/status")) return true;
  if (p.startsWith("/api/setup/")) return true;
  // WHY: setup UI is served by the same SPA bundle; static assets must remain reachable
  // while functional app APIs/routes stay gated.
  if (p.startsWith("/assets/")) return true;
  if (p === "/icon.svg" || p === "/favicon.ico" || p === "/manifest.webmanifest") return true;
  if (/\.(css|js|mjs|map|png|jpg|jpeg|svg|ico|webp|woff|woff2|ttf|eot)$/i.test(p)) return true;
  return false;
}

/**
 * Middleware that enforces setup mode by blocking non-setup routes when setup is required.
 * @param {object} req - Express request object
 * @param {object} res - Express response object
 * @param {Function} next - Express next middleware function
 * @returns {Promise<void>}
 */
async function enforceSetupMode(req, res, next) {
  if (!repo || !configStore || !smtpService) return next();
  const status = await refreshConfigStatus();
  req.configStatus = status;
  if (status?.overall !== "SETUP_REQUIRED") return next();
  if (isSetupPathAllowed(req)) return next();
  if (req.path.startsWith("/api/")) {
    return res.status(503).json({
      ok: false,
      error: "SETUP_REQUIRED",
      message: "Application is in setup mode. Complete required setup steps.",
      setupRequired: true
    });
  }
  return res.redirect("/setup");
}

/**
 * Returns a random element from the provided array.
 * @param {Array<any>} list - Array to select from
 * @returns {any} Randomly selected element
 */
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

function defaultGamePreferences(userId = null) {
  return {
    userId,
    mode: "learning",
    level: 1,
    contentType: "default",
    language: "en",
    updatedAt: new Date().toISOString()
  };
}

function normalizeDateKey(value) {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function dayDiffUtc(aKey, bKey) {
  if (!aKey || !bKey) return 0;
  const a = new Date(`${aKey}T00:00:00.000Z`).getTime();
  const b = new Date(`${bKey}T00:00:00.000Z`).getTime();
  return Math.round((a - b) / 86400000);
}

function normalizeVocabularyType(input = "words") {
  const value = String(input || "words").toLowerCase();
  if (["words", "sentences", "fiction", "code"].includes(value)) return value;
  if (value === "level2" || value === "level3") return "words";
  if (value === "sentence_words") return "sentences";
  return "words";
}

function normalizeVocabularyStatus(input = "draft") {
  const value = String(input || "draft").toLowerCase();
  if (["draft", "published", "archived"].includes(value)) return value;
  if (value === "DRAFT") return "draft";
  if (value === "PUBLISHED") return "published";
  if (value === "ARCHIVED") return "archived";
  return "draft";
}

function normalizeVocabularySource(input = "manual") {
  const value = String(input || "manual").toLowerCase();
  if (["manual", "openai", "imported", "online_generated"].includes(value)) return value;
  return "manual";
}

function safeParseJson(input, fallback) {
  try {
    return input ? JSON.parse(input) : fallback;
  } catch {
    return fallback;
  }
}

function extractFirstJsonArraySubstring(raw) {
  const text = String(raw || "");
  const start = text.indexOf("[");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === "\"") {
        inString = false;
      }
      continue;
    }
    if (ch === "\"") {
      inString = true;
      continue;
    }
    if (ch === "[") depth += 1;
    if (ch === "]") {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function safeParseJsonArrayOfStrings(raw, maxCount = 500) {
  const normalizedMax = Math.max(1, Math.min(1000, Number(maxCount) || 500));
  const direct = safeParseJson(raw, null);
  let arr = Array.isArray(direct) ? direct : null;
  if (!arr) {
    const wrapped = direct && Array.isArray(direct.items) ? direct.items : null;
    if (wrapped) arr = wrapped;
  }
  if (!arr) {
    const fromSubstring = extractFirstJsonArraySubstring(raw);
    if (fromSubstring) arr = safeParseJson(fromSubstring, null);
  }
  if (!Array.isArray(arr)) return [];
  const seen = new Set();
  const out = [];
  for (const item of arr) {
    if (typeof item !== "string") continue;
    const cleaned = item.replace(/\s+/g, " ").trim();
    if (!cleaned) continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(cleaned);
    if (out.length >= normalizedMax) break;
  }
  return out;
}

function buildVocabularyGenerationPrompts({ language, level, type, count, theme }) {
  const safeTheme = String(theme || "").trim();
  const typeRules = type === "words"
    ? "Return single vocabulary words only. No spaces, no numbering, no markdown."
    : "Return complete short sentences or chunks. Include spaces and natural punctuation.";
  const levelRules = {
    1: "Very short and basic items only.",
    2: "Beginner level. Keep words/sentences simple and easy to type.",
    3: "Intermediate beginner level with slightly longer vocabulary.",
    4: "Intermediate level with richer sentence structure and punctuation.",
    5: "Advanced learner-friendly level with longer and more complex content."
  };
  const languageRule = String(language || "en").toLowerCase() === "ru"
    ? "Use only Russian Cyrillic letters. Do not use transliteration or Latin words."
    : "Use only English Latin letters and standard punctuation.";
  const contentRule = safeTheme
    ? `Theme/topic: ${safeTheme}.`
    : "Theme/topic: general kid-safe educational content.";
  const system = [
    "You are a strict JSON generator for a typing game content pipeline.",
    "Return ONLY valid JSON array syntax.",
    "No markdown, no explanation, no code fences."
  ].join(" ");
  const developer = [
    `Generate exactly ${count} items for language=${language}, level=${level}, type=${type}.`,
    languageRule,
    levelRules[Number(level)] || levelRules[3],
    typeRules,
    contentRule,
    "Each item must be a string.",
    "Return ONLY a JSON array of strings with exactly the requested item count.",
    "Never return an object, key-value wrapper, or prose.",
    "No comments."
  ].join(" ");
  return { system, developer };
}

function validateGeneratedVocabularyItems(items, { type, level, language = "en" }) {
  const errors = [];
  const validated = [];
  const numericLevel = clampNumber(level, 1, 5, 1);
  const wordMaxByLevel = { 1: 2, 2: 4, 3: 7, 4: 10, 5: 14 };
  const sentenceMaxByLevel = { 1: 24, 2: 36, 3: 52, 4: 72, 5: 96 };
  const wordMaxLen = wordMaxByLevel[numericLevel] || 7;
  const sentenceMaxLen = sentenceMaxByLevel[numericLevel] || 52;
  const lang = String(language || "en").toLowerCase();
  const ruWordPattern = /^[\u0400-\u04FF-]+$/;
  const ruSentencePattern = /^[\u0400-\u04FF0-9\s.,!?;:()\-"'«»]+$/;
  const enWordPattern = /^[A-Za-z-]+$/;
  const enSentencePattern = /^[A-Za-z0-9\s.,!?;:()\-'"`]+$/;
  for (const raw of items) {
    const text = String(raw || "").trim();
    if (!text) continue;
    if (text.includes("\n")) continue;
    if (type === "words") {
      if (text.length > wordMaxLen) continue;
      if (text.includes(" ")) continue;
      if (lang === "ru" && !ruWordPattern.test(text)) continue;
      if (lang !== "ru" && !enWordPattern.test(text)) continue;
      validated.push(text);
      continue;
    }
    if (!text.includes(" ")) continue;
    if (text.length > sentenceMaxLen) continue;
    if (lang === "ru" && !ruSentencePattern.test(text)) continue;
    if (lang !== "ru" && !enSentencePattern.test(text)) continue;
    validated.push(text);
  }
  if (!validated.length) errors.push("No valid items after type-level validation.");
  return { items: validated, errors };
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

function openAIEphemeralActorKey(actor) {
  if (!actor?.isAuthenticated || !actor?.id) return null;
  return `user:${actor.id}`;
}

function cleanupOpenAIEphemeralKeys() {
  const cutoff = Date.now() - OPENAI_EPHEMERAL_TTL_MS;
  for (const [key, value] of openaiEphemeralKeys.entries()) {
    if (!value || Number(value.updatedAtMs || 0) < cutoff) {
      openaiEphemeralKeys.delete(key);
    }
  }
}

function setOpenAIEphemeralKey(actor, apiKey, model = OPENAI_MODEL) {
  const actorKey = openAIEphemeralActorKey(actor);
  if (!actorKey || !apiKey) return;
  openaiEphemeralKeys.set(actorKey, {
    apiKey: String(apiKey),
    model: String(model || OPENAI_MODEL),
    updatedAtMs: Date.now()
  });
}

function getOpenAIEphemeralKey(actor) {
  cleanupOpenAIEphemeralKeys();
  const actorKey = openAIEphemeralActorKey(actor);
  if (!actorKey) return null;
  const value = openaiEphemeralKeys.get(actorKey);
  return value || null;
}

function clearOpenAIEphemeralKey(actor) {
  const actorKey = openAIEphemeralActorKey(actor);
  if (!actorKey) return;
  openaiEphemeralKeys.delete(actorKey);
}

function hasEncryptedOpenAIKey(enc) {
  return Boolean(enc?.ciphertext && enc?.iv && (enc?.authTag || enc?.authtag));
}

function decryptOpenAIEncryptedKey(enc) {
  if (!enc || !hasEncryptedOpenAIKey(enc)) return null;
  if (!encryptionService?.isConfigured()) return null;
  try {
    return encryptionService.decrypt({
      ciphertext: enc.ciphertext,
      iv: enc.iv,
      authTag: enc.authTag || enc.authtag
    });
  } catch {
    return null;
  }
}

async function getOpenAIServiceConfig() {
  return configStore.get("service.openai", {
    scope: "global",
    scopeId: "global",
    fallback: {
      enabled: false,
      storeInDb: true,
      model: OPENAI_MODEL,
      apiKeyEnc: null,
      lastTestAt: null,
      lastTestOk: false,
      lastTestError: null,
      lastTestCode: null,
      updatedAt: null
    }
  });
}

async function saveOpenAIServiceConfig(nextValue, updatedBy = "system") {
  const payload = {
    enabled: Boolean(nextValue?.enabled),
    storeInDb: nextValue?.storeInDb !== false,
    model: String(nextValue?.model || OPENAI_MODEL),
    apiKeyEnc: nextValue?.apiKeyEnc || null,
    lastTestAt: nextValue?.lastTestAt || null,
    lastTestOk: Boolean(nextValue?.lastTestOk),
    lastTestError: nextValue?.lastTestError ? String(nextValue.lastTestError).slice(0, 400) : null,
    lastTestCode: nextValue?.lastTestCode ? String(nextValue.lastTestCode).slice(0, 64) : null,
    updatedAt: new Date().toISOString()
  };
  await configStore.setSafe("service.openai", payload, {
    scope: "global",
    scopeId: "global",
    updatedBy
  });
  return payload;
}

function summarizeOpenAIServiceStatus(config) {
  const cfg = config || {};
  return {
    enabled: Boolean(cfg.enabled),
    storeInDb: cfg.storeInDb !== false,
    configured: cfg.storeInDb === false
      ? false
      : hasEncryptedOpenAIKey(cfg.apiKeyEnc),
    model: String(cfg.model || OPENAI_MODEL),
    lastTestAt: cfg.lastTestAt || null,
    lastTestOk: Boolean(cfg.lastTestOk),
    lastTestError: cfg.lastTestError || null,
    lastTestCode: cfg.lastTestCode || null
  };
}

function classifyOpenAITestError(err) {
  const status = Number(err?.status || 0);
  const message = String(err?.message || err?.body || "OpenAI request failed");
  if (status === 401 || status === 403 || /invalid api key|incorrect api key|unauthorized|forbidden/i.test(message)) {
    return { code: "unauthorized", message: "Unauthorized key or access denied." };
  }
  if (status === 404 || /model .*does not exist|not found|permission/i.test(message)) {
    return { code: "invalid_model_permission", message: "Model not available for this key." };
  }
  if (status === 429 || /rate limit|quota/i.test(message)) {
    return { code: "rate_limited", message: "Rate limited or quota exceeded." };
  }
  if (err?.name === "AbortError" || /timed out|network|fetch failed|ENOTFOUND|ECONN/i.test(message)) {
    return { code: "network", message: "Network error while contacting OpenAI." };
  }
  return { code: "unknown", message: "OpenAI test failed." };
}

async function resolveOpenAIExecutionContext(actor, { includeLegacy = true } = {}) {
  const serviceConfig = await getOpenAIServiceConfig();
  const serviceModel = String(serviceConfig?.model || OPENAI_MODEL);
  if (Boolean(serviceConfig?.enabled)) {
    if (serviceConfig?.storeInDb !== false) {
      const keyFromDb = decryptOpenAIEncryptedKey(serviceConfig?.apiKeyEnc);
      if (keyFromDb) {
        return {
          apiKey: keyFromDb,
          source: "service.openai.db",
          model: serviceModel,
          persisted: true
        };
      }
    } else {
      const ephemeral = getOpenAIEphemeralKey(actor);
      if (ephemeral?.apiKey) {
        return {
          apiKey: String(ephemeral.apiKey),
          source: "service.openai.ephemeral",
          model: String(ephemeral.model || serviceModel),
          persisted: false
        };
      }
    }
  }

  if (!includeLegacy) return null;

  if (actor?.id && encryptionService?.isConfigured()) {
    const row = await repo.getUserSecret(actor.id, "openai_api_key");
    if (row) {
      return {
        apiKey: encryptionService.decrypt({
          ciphertext: row.ciphertext,
          iv: row.iv,
          authTag: row.authtag || row.authTag
        }),
        source: "legacy.user_secret",
        model: serviceModel,
        persisted: true
      };
    }
  }
  const oldKey = await getSetting("openai_key");
  if (oldKey) {
    return {
      apiKey: String(oldKey),
      source: "legacy.settings",
      model: serviceModel,
      persisted: true
    };
  }
  return null;
}

async function applyOpenAIServiceSettings({
  actor,
  apiKey,
  storeKey,
  enabled,
  model
}) {
  const current = await getOpenAIServiceConfig();
  const next = {
    ...(current || {}),
    enabled: enabled === undefined ? Boolean(current?.enabled) : Boolean(enabled),
    storeInDb: storeKey === undefined ? (current?.storeInDb !== false) : Boolean(storeKey),
    model: String(model || current?.model || OPENAI_MODEL)
  };

  let trimmedKey = String(apiKey || "").trim();
  if (!trimmedKey && next.storeInDb && storeKey !== undefined) {
    const ephemeral = getOpenAIEphemeralKey(actor);
    if (ephemeral?.apiKey) {
      trimmedKey = String(ephemeral.apiKey);
    }
  }
  if (!trimmedKey && next.storeInDb === false && storeKey !== undefined && hasEncryptedOpenAIKey(current?.apiKeyEnc)) {
    const fromDb = decryptOpenAIEncryptedKey(current?.apiKeyEnc);
    if (fromDb) {
      trimmedKey = fromDb;
    }
  }

  if (trimmedKey) {
    next.enabled = true;
    next.lastTestOk = false;
    next.lastTestError = null;
    next.lastTestCode = null;
    next.lastTestAt = null;
    if (next.storeInDb) {
      if (!encryptionService?.isConfigured()) {
        throw new AppError("Encryption is not configured for DB key storage", {
          status: 400,
          code: "ENCRYPTION_NOT_CONFIGURED",
          expose: true
        });
      }
      next.apiKeyEnc = encryptionService.encrypt(trimmedKey);
      clearOpenAIEphemeralKey(actor);
    } else {
      setOpenAIEphemeralKey(actor, trimmedKey, next.model);
      next.apiKeyEnc = null;
    }
  } else if (storeKey !== undefined && next.storeInDb === false) {
    // WHY: explicit DB-storage disable switches the active source to ephemeral-only.
    if (hasEncryptedOpenAIKey(current?.apiKeyEnc)) {
      const fromDb = decryptOpenAIEncryptedKey(current.apiKeyEnc);
      if (fromDb) setOpenAIEphemeralKey(actor, fromDb, next.model);
    }
    next.apiKeyEnc = null;
  } else if (storeKey !== undefined && next.storeInDb === true && !hasEncryptedOpenAIKey(current?.apiKeyEnc)) {
    throw new AppError("API key is required to enable DB storage", {
      status: 400,
      code: "OPENAI_KEY_REQUIRED",
      expose: true
    });
  }

  const saved = await saveOpenAIServiceConfig(next, actor?.externalSubject || "admin");
  return summarizeOpenAIServiceStatus(saved);
}

async function runOpenAIConnectivityTest(actor, requestId) {
  const startedAt = new Date().toISOString();
  const resolved = await resolveOpenAIExecutionContext(actor, { includeLegacy: true });
  if (!resolved?.apiKey) {
    throw new AppError("OpenAI key is not configured", {
      status: 400,
      code: "OPENAI_KEY_MISSING",
      expose: true,
      metadata: { requestId }
    });
  }
  const model = String(resolved.model || OPENAI_MODEL);
  await callOpenAI({
    apiKey: resolved.apiKey,
    model,
    temperature: 0,
    maxTokens: 64,
    systemPrompt: "Return only JSON.",
    prompt: "Return ONLY this JSON object: {\"ok\":true}"
  });
  return {
    ok: true,
    source: resolved.source,
    model,
    requestId: requestId || null,
    testedAt: startedAt
  };
}

async function persistOpenAITestStatus({ ok, code = null, errorMessage = null }) {
  const current = await getOpenAIServiceConfig();
  await saveOpenAIServiceConfig({
    ...(current || {}),
    lastTestAt: new Date().toISOString(),
    lastTestOk: Boolean(ok),
    lastTestCode: code ? String(code) : null,
    lastTestError: errorMessage ? String(errorMessage).slice(0, 400) : null
  }, "openai-test");
}

async function storeLegacyOpenAIKeyForActor(actor, apiKey) {
  if (!apiKey) return;
  if (actor?.id && encryptionService?.isConfigured()) {
    // SECURITY: OpenAI keys are encrypted at rest with AES-256-GCM and never logged.
    const encrypted = encryptionService.encrypt(apiKey);
    await repo.upsertUserSecret(actor.id, "openai_api_key", encrypted);
    return;
  }
  await setSetting("openai_key", apiKey);
}

async function storeOpenAIKeyForActor(actor, apiKey) {
  return storeLegacyOpenAIKeyForActor(actor, apiKey);
}

async function getOpenAIKeyForActor(actor) {
  const ctx = await resolveOpenAIExecutionContext(actor, { includeLegacy: true });
  return ctx?.apiKey || null;
}

async function getActivePack(type) {
  const row = await repo.getActivePack(type);
  if (!row) return null;
  return {
    ...row,
    items: typeof row.items === "string" ? JSON.parse(row.items) : row.items
  };
}

function getVocabularyTypeForLevel(level) {
  return level >= 4 ? "sentences" : "words";
}

function normalizeGameSessionId(raw, actor, ip) {
  const text = String(raw || "").trim();
  if (text && text.length <= 128) return text;
  if (actor?.isAuthenticated && actor?.id) return `user:${actor.id}`;
  return `guest:${String(ip || "unknown").slice(0, 64)}`;
}

function makeDefaultModeChannelKey(language, level, type) {
  return `${String(language || "en").toLowerCase()}|${Number(level || 1)}|${type}|default`;
}

function cleanupDefaultModeSessions() {
  const cutoff = Date.now() - DEFAULT_MODE_SESSION_TTL_MS;
  for (const [sessionId, state] of defaultModeSessionState.entries()) {
    if (!state || Number(state.lastTouchedAtMs || 0) < cutoff) {
      defaultModeSessionState.delete(sessionId);
    }
  }
}

function ensureDefaultModeSession(sessionId) {
  cleanupDefaultModeSessions();
  if (!defaultModeSessionState.has(sessionId)) {
    defaultModeSessionState.set(sessionId, {
      channels: new Map(),
      lastTouchedAtMs: Date.now()
    });
  }
  const session = defaultModeSessionState.get(sessionId);
  session.lastTouchedAtMs = Date.now();
  return session;
}

function ensureDefaultModeChannel(sessionState, channelKey) {
  if (!sessionState.channels.has(channelKey)) {
    sessionState.channels.set(channelKey, {
      activePackId: null,
      usedPackIds: new Set(),
      usedEntryIndicesByPack: new Map(),
      lastTelemetryCpm: 0,
      lastServedAtMs: 0
    });
  }
  return sessionState.channels.get(channelKey);
}

function buildFallbackTasks(level, count, language) {
  const tasks = [];
  const useRuDefaults = language === "ru";
  const level2Words = useRuDefaults ? defaults.level2WordsRu : defaults.level2Words;
  const level3Words = useRuDefaults ? defaults.level3WordsRu : defaults.level3Words;
  const sentenceWords = useRuDefaults ? defaults.sentenceWordsRu : defaults.sentenceWords;

  if (level === 1) {
    for (let i = 0; i < count; i += 1) {
      const pool = [...(language === "ru" ? defaults.lettersRu : defaults.letters), ...defaults.digits];
      const letter = chooseRandom(pool);
      tasks.push({ id: `${level}-c-${Date.now()}-${i}`, level, prompt: letter, answer: letter });
    }
    return tasks;
  }

  if (level === 2) {
    for (let i = 0; i < count; i += 1) {
      const word = chooseRandom(level2Words);
      tasks.push({ id: `${level}-w-${Date.now()}-${i}`, level, prompt: word, answer: word });
    }
    return tasks;
  }

  if (level === 3) {
    for (let i = 0; i < count; i += 1) {
      const word = chooseRandom(level3Words);
      tasks.push({ id: `${level}-w-${Date.now()}-${i}`, level, prompt: word, answer: word });
    }
    return tasks;
  }

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
  return tasks.slice(0, count);
}

function buildTasksFromVocabularyEntries({ level, count, entries, channelState, packId }) {
  const tasks = [];
  if (!Array.isArray(entries) || entries.length === 0) return { tasks, depleted: true, remainingEntries: 0 };
  const total = entries.length;
  const usedSet = channelState.usedEntryIndicesByPack.get(packId) || new Set();
  if (!channelState.usedEntryIndicesByPack.has(packId)) {
    channelState.usedEntryIndicesByPack.set(packId, usedSet);
  }
  const unservedIndices = [];
  for (let i = 0; i < total; i += 1) {
    if (!usedSet.has(i)) unservedIndices.push(i);
  }

  if (level <= 3) {
    const candidate = [...unservedIndices];
    while (candidate.length < count) {
      candidate.push(Math.floor(Math.random() * total));
    }
    for (let i = 0; i < candidate.length && tasks.length < count; i += 1) {
      const idx = candidate[i];
      usedSet.add(idx);
      const text = String(entries[idx] || "").trim();
      if (!text) continue;
      tasks.push({
        id: `${level}-w-${packId}-${Date.now()}-${tasks.length}`,
        level,
        prompt: text,
        answer: text
      });
    }
  } else {
    const candidate = [...unservedIndices];
    while (candidate.length < total * 3 && tasks.length < count) {
      candidate.push(Math.floor(Math.random() * total));
      if (candidate.length > count * 4) break;
    }
    for (let i = 0; i < candidate.length && tasks.length < count; i += 1) {
      const idx = candidate[i];
      usedSet.add(idx);
      const sentence = String(entries[idx] || "").replace(/\s+/g, " ").trim();
      if (!sentence) continue;
      const words = sentence.split(" ").filter(Boolean);
      if (!words.length) continue;
      for (let wordIndex = 0; wordIndex < words.length && tasks.length < count; wordIndex += 1) {
        const word = words[wordIndex];
        tasks.push({
          id: `${level}-s-${packId}-${Date.now()}-${tasks.length}`,
          level,
          prompt: word,
          answer: word,
          sentence,
          wordIndex,
          words
        });
      }
    }
  }

  const remainingEntries = Math.max(0, total - usedSet.size);
  const depleted = remainingEntries <= 0;
  if (depleted) channelState.activePackId = null;
  return { tasks: tasks.slice(0, count), depleted, remainingEntries };
}

async function generateStrictVocabularyItems({
  apiKey,
  model,
  language,
  level,
  type,
  count,
  requestId,
  theme = "general educational typing content"
}) {
  const prompts = buildVocabularyGenerationPrompts({ language, level, type, count, theme });
  let lastRaw = "";
  let best = [];
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const prompt = attempt === 1
      ? prompts.developer
      : `Fix this model output. Return ONLY a valid JSON array of strings with exactly ${count} items.\n\n${lastRaw}`;
    lastRaw = await callOpenAI({
      apiKey,
      model,
      temperature: 0.4,
      maxTokens: 1400,
      systemPrompt: prompts.system,
      prompt
    });
    const parsed = safeParseJsonArrayOfStrings(lastRaw, count * 3);
    const validated = validateGeneratedVocabularyItems(parsed, { type, level, language });
    const deduped = Array.from(new Set(validated.items.map((x) => String(x || "").trim()).filter(Boolean)));
    if (deduped.length >= count) {
      return { items: deduped.slice(0, count), raw: lastRaw, attempts: attempt };
    }
    if (deduped.length > best.length) best = deduped;
  }
  throw new AppError("Generator output is invalid JSON items array", {
    status: 400,
    code: "GEN_INVALID_OUTPUT",
    expose: true,
    metadata: { requestId, parsedCount: best.length, minRequired: count }
  });
}

async function persistGeneratedPack({ language, level, type, items, model, metadata = {}, createdBy = null }) {
  const now = new Date().toISOString();
  const id = randomUUID();
  const normalizedType = normalizeVocabularyType(type);
  await repo.createVocabularyPack({
    id,
    name: `Auto ${String(language || "en").toUpperCase()} L${level} ${normalizedType} ${now.slice(0, 16).replace("T", " ")}`,
    language: String(language || "en").toLowerCase(),
    level: clampNumber(level, 1, 5, 1),
    type: normalizedType,
    status: "published",
    source: "online_generated",
    version: 1,
    generator_config: {
      model: String(model || OPENAI_MODEL),
      prompt_template: "default_mode_auto_generation",
      temperature: 0.4
    },
    metadata: {
      generated_for_default_mode: true,
      ...metadata
    },
    created_at: now,
    updated_at: now
  });
  const entries = items.map((text, idx) => ({
    id: randomUUID(),
    text: String(text || "").trim(),
    order_index: idx,
    difficulty_score: null,
    tags: null,
    created_at: now
  })).filter((row) => row.text);
  await repo.replaceVocabularyEntries(id, entries);
  await repo.createVocabularyVersion({
    id: randomUUID(),
    pack_id: id,
    version: 1,
    snapshot_json: {
      pack: await repo.getVocabularyPackById(id),
      entries: await repo.listVocabularyEntries(id)
    },
    change_note: "online generated for default mode",
    created_by: createdBy ? String(createdBy) : null,
    created_at: now
  });
  return id;
}

async function scheduleBackgroundGenerationIfNeeded({
  actor,
  requestId,
  language,
  level,
  type,
  triggerReason,
  requestCount = 60
}) {
  const lockKey = `${String(language || "en").toLowerCase()}|${level}|${normalizeVocabularyType(type)}|default`;
  if (defaultModeGenerationInFlight.has(lockKey)) return false;
  const openaiCtx = await resolveOpenAIExecutionContext(actor, { includeLegacy: true });
  if (!openaiCtx?.apiKey) return false;

  const run = (async () => {
    try {
      const generated = await generateStrictVocabularyItems({
        apiKey: openaiCtx.apiKey,
        model: openaiCtx.model || OPENAI_MODEL,
        language,
        level,
        type: normalizeVocabularyType(type),
        count: clampNumber(requestCount, 10, 200, 60),
        requestId,
        theme: "default gameplay rotation"
      });
      const packId = await persistGeneratedPack({
        language,
        level,
        type: normalizeVocabularyType(type),
        items: generated.items,
        model: openaiCtx.model || OPENAI_MODEL,
        createdBy: actor?.id || null,
        metadata: {
          source_hint: openaiCtx.source,
          request_id: requestId || null,
          trigger_reason: triggerReason
        }
      });
      logger.info("default_mode_background_generation_ok", {
        requestId: requestId || null,
        language,
        level,
        type: normalizeVocabularyType(type),
        packId,
        source: openaiCtx.source
      });
    } catch (err) {
      logger.warn("default_mode_background_generation_failed", {
        requestId: requestId || null,
        language,
        level,
        type: normalizeVocabularyType(type),
        error: String(err?.message || err || "unknown")
      });
    } finally {
      defaultModeGenerationInFlight.delete(lockKey);
    }
  })();
  defaultModeGenerationInFlight.set(lockKey, run);
  return true;
}

async function selectNextContentPack(sessionCtx, playerSettings) {
  const { channelState } = sessionCtx;
  const language = String(playerSettings?.language || "en").toLowerCase();
  const level = clampNumber(playerSettings?.level, 1, 5, 1);
  const type = normalizeVocabularyType(playerSettings?.type || "words");
  const packResult = await repo.listVocabularyPacks(
    {
      language,
      level,
      type,
      status: "published"
    },
    {
      page: 1,
      pageSize: 500,
      sortBy: "updated_at",
      sortDir: "desc"
    }
  );
  const packs = Array.isArray(packResult?.rows) ? packResult.rows : [];
  const packsById = new Map(packs.map((pack) => [String(pack.id), pack]));
  let selectedPack = null;
  let reason = "none";

  if (channelState.activePackId && packsById.has(String(channelState.activePackId))) {
    selectedPack = packsById.get(String(channelState.activePackId));
    const usedSet = channelState.usedEntryIndicesByPack.get(String(selectedPack.id));
    const total = Number(selectedPack.entry_count || 0);
    if (usedSet && total > 0 && usedSet.size >= total) {
      channelState.activePackId = null;
      selectedPack = null;
    } else {
      reason = "active_pack";
    }
  } else if (channelState.activePackId) {
    channelState.activePackId = null;
  }

  if (!selectedPack) {
    const unused = packs.filter((pack) => !channelState.usedPackIds.has(String(pack.id)));
    if (unused.length > 0) {
      selectedPack = chooseRandom(unused);
      channelState.activePackId = String(selectedPack.id);
      channelState.usedPackIds.add(String(selectedPack.id));
      reason = "unused_pack";
    }
  }

  const allUsed = !selectedPack && packs.length > 0;
  if (allUsed) {
    selectedPack = chooseRandom(packs);
    reason = "fallback_reuse_pack";
  }
  const unusedPacksExist = packs.some((pack) => !channelState.usedPackIds.has(String(pack.id)));
  return { selectedPack, packs, reason, allUsed, unusedPacksExist };
}

const contentService = {
  selectNextContentPack,
  scheduleBackgroundGenerationIfNeeded,
  persistGeneratedPack
};

async function generateTasks(level, count, contentMode, language = "en", runtimeCtx = {}) {
  const safeLevel = clampNumber(level, 1, 5, 1);
  const safeCount = clampNumber(count, 5, 200, 10);
  const safeLanguage = String(language || "en").toLowerCase();

  // Legacy published packs path remains unchanged for explicit vocab mode.
  if (contentMode === "vocab") {
    const tasks = [];
    const level2PackItems = await repo.getPublishedPackItems({ language: safeLanguage, type: "level2" });
    const level3PackItems = await repo.getPublishedPackItems({ language: safeLanguage, type: "level3" });
    const sentencePackItems = await repo.getPublishedPackItems({ language: safeLanguage, type: "sentence_words" });
    const useRuDefaults = safeLanguage === "ru";
    const level2Words = level2PackItems.length ? level2PackItems.map((row) => row.text) : (useRuDefaults ? defaults.level2WordsRu : defaults.level2Words);
    const level3Words = level3PackItems.length ? level3PackItems.map((row) => row.text) : (useRuDefaults ? defaults.level3WordsRu : defaults.level3Words);
    const sentenceWords = sentencePackItems.length ? sentencePackItems.map((row) => row.text) : (useRuDefaults ? defaults.sentenceWordsRu : defaults.sentenceWords);

    if (safeLevel === 1) {
      return buildFallbackTasks(1, safeCount, safeLanguage);
    }
    if (safeLevel === 2) {
      for (let i = 0; i < safeCount; i += 1) {
        const word = chooseRandom(level2Words);
        tasks.push({ id: `${safeLevel}-w-${Date.now()}-${i}`, level: safeLevel, prompt: word, answer: word });
      }
      return tasks;
    }
    if (safeLevel === 3) {
      for (let i = 0; i < safeCount; i += 1) {
        const word = chooseRandom(level3Words);
        tasks.push({ id: `${safeLevel}-w-${Date.now()}-${i}`, level: safeLevel, prompt: word, answer: word });
      }
      return tasks;
    }
    while (tasks.length < safeCount) {
      const maxWords = safeLevel === 4 ? 3 : 9;
      const minWords = safeLevel === 4 ? 2 : 4;
      const length = Math.floor(Math.random() * (maxWords - minWords + 1)) + minWords;
      const words = Array.from({ length }, () => chooseRandom(sentenceWords));
      const sentence = words.join(" ");
      words.forEach((word, idx) => {
        tasks.push({
          id: `${safeLevel}-s-${Date.now()}-${tasks.length}`,
          level: safeLevel,
          prompt: word,
          answer: word,
          sentence,
          wordIndex: idx,
          words
        });
      });
    }
    return tasks.slice(0, safeCount);
  }

  if (safeLevel === 1) {
    return buildFallbackTasks(1, safeCount, safeLanguage);
  }

  const sessionId = normalizeGameSessionId(runtimeCtx.sessionId, runtimeCtx.actor, runtimeCtx.ip);
  const sessionState = ensureDefaultModeSession(sessionId);
  const contentType = getVocabularyTypeForLevel(safeLevel);
  const channelKey = makeDefaultModeChannelKey(safeLanguage, safeLevel, contentType);
  const channelState = ensureDefaultModeChannel(sessionState, channelKey);
  const selection = await contentService.selectNextContentPack(
    { sessionId, channelKey, channelState },
    { language: safeLanguage, level: safeLevel, type: contentType }
  );
  let selectedPack = selection.selectedPack;

  if (selection.allUsed) {
    void contentService.scheduleBackgroundGenerationIfNeeded({
      actor: runtimeCtx.actor,
      requestId: runtimeCtx.requestId,
      language: safeLanguage,
      level: safeLevel,
      type: contentType,
      triggerReason: "all_packs_used",
      requestCount: Math.max(40, safeCount)
    });
  }

  if (!selectedPack && selection.packs.length > 0) {
    selectedPack = selection.selectedPack;
  }

  if (!selectedPack) {
    void contentService.scheduleBackgroundGenerationIfNeeded({
      actor: runtimeCtx.actor,
      requestId: runtimeCtx.requestId,
      language: safeLanguage,
      level: safeLevel,
      type: contentType,
      triggerReason: "no_matching_packs",
      requestCount: Math.max(40, safeCount)
    });
    return buildFallbackTasks(safeLevel, safeCount, safeLanguage);
  }

  const selectedPackId = String(selectedPack.id);
  const packEntries = (await repo.listVocabularyEntries(selectedPackId))
    .map((row) => String(row.text || "").trim())
    .filter(Boolean);
  if (!packEntries.length) {
    channelState.activePackId = null;
    return buildFallbackTasks(safeLevel, safeCount, safeLanguage);
  }
  const result = buildTasksFromVocabularyEntries({
    level: safeLevel,
    count: safeCount,
    entries: packEntries,
    channelState,
    packId: selectedPackId
  });
  channelState.lastServedAtMs = Date.now();

  const telemetryCpm = clampNumber(runtimeCtx?.telemetry?.cpm, 0, 10_000, 0);
  if (telemetryCpm > 0) channelState.lastTelemetryCpm = telemetryCpm;
  const effectiveCpm = telemetryCpm > 0 ? telemetryCpm : channelState.lastTelemetryCpm;
  const averageChars = Math.max(1, Math.round(packEntries.reduce((acc, item) => acc + item.length, 0) / Math.max(1, packEntries.length)));
  const remainingChars = result.remainingEntries * averageChars;
  const charsPerSec = effectiveCpm > 0 ? (effectiveCpm / 60) : 0;
  const remainingSeconds = charsPerSec > 0 ? (remainingChars / charsPerSec) : Number.POSITIVE_INFINITY;
  if (!selection.unusedPacksExist && remainingSeconds < 10) {
    void contentService.scheduleBackgroundGenerationIfNeeded({
      actor: runtimeCtx.actor,
      requestId: runtimeCtx.requestId,
      language: safeLanguage,
      level: safeLevel,
      type: contentType,
      triggerReason: "low_buffer",
      requestCount: Math.max(40, safeCount)
    });
  }

  if (!result.tasks.length) {
    return buildFallbackTasks(safeLevel, safeCount, safeLanguage);
  }
  return result.tasks;
}

async function callOpenAI({ apiKey, prompt, systemPrompt = "", model = OPENAI_MODEL, temperature = 0.7, maxTokens = null }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  const input = [];
  if (systemPrompt) input.push({ role: "system", content: systemPrompt });
  input.push({ role: "user", content: String(prompt || "") });
  if (Array.isArray(prompt)) {
    input.length = 0;
    input.push(...prompt);
  }
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`
    },
    signal: controller.signal,
    body: JSON.stringify({
      model,
      input,
      temperature,
      ...(maxTokens ? { max_output_tokens: Number(maxTokens) } : {})
    })
  });
  clearTimeout(timeout);

  if (!response.ok) {
    const text = await response.text();
    const err = new Error(`OpenAI request failed (${response.status})`);
    err.status = response.status;
    err.body = text;
    throw err;
  }

  const data = await response.json();
  const output = data.output?.[0]?.content?.[0]?.text || data.output_text || "";
  return output;
}

async function verifyGoogleCredential(idToken) {
  const providers = await configStore.get("auth.providers", {
    scope: "global",
    scopeId: "global",
    fallback: {
      google: { enabled: Boolean(BOOTSTRAP_GOOGLE_CLIENT_ID), clientId: BOOTSTRAP_GOOGLE_CLIENT_ID || "" }
    }
  });
  const googleClientId = String(providers?.google?.clientId || BOOTSTRAP_GOOGLE_CLIENT_ID || "");
  if (!providers?.google?.enabled || !googleClientId) throw new Error("Google auth is not configured");
  // SECURITY: verify token signature and audience server-side before trusting claims.
  const { OAuth2Client } = require("google-auth-library");
  const client = new OAuth2Client(googleClientId);
  const ticket = await client.verifyIdToken({
    idToken,
    audience: googleClientId
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
  const setupRequired = Boolean(req.configStatus?.overall === "SETUP_REQUIRED" || setupModeActive);
  res.json({
    ok: !setupRequired,
    service: "ktrain",
    driver: activeDriver,
    maintenanceMode,
    setupRequired,
    startupReady,
    appMode: currentAppMode,
    build: BUILD_INFO
  });
});

app.get("/readyz", async (req, res) => {
  if (!startupReady) {
    return res.status(503).json({ ok: false, ready: false, error: "Startup not complete", phase: startupPhase });
  }
  if (req.configStatus?.overall === "SETUP_REQUIRED" || setupModeActive) {
    return res.status(503).json({ ok: false, ready: false, error: "Setup required", setupRequired: true });
  }
  try {
    await repo.ping();
    res.json({ ok: true, ready: true, driver: activeDriver });
  } catch (err) {
    res.status(503).json({ ok: false, ready: false, error: "DB not reachable" });
  }
});

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    driver: activeDriver,
    dbDriverEnv: DB_DRIVER_ENV,
    startupReady,
    setupModeActive,
    appMode: currentAppMode,
    build: BUILD_INFO
  });
});

app.get("/api/public/config/status", withAsync(async (req, res) => {
  const status = await refreshConfigStatus();
  res.json({
    ok: true,
    overall: status?.overall || "SETUP_REQUIRED",
    setupRequired: (status?.overall || "SETUP_REQUIRED") === "SETUP_REQUIRED",
    computed_at: status?.computed_at || new Date().toISOString()
  });
}));

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
  const providerConfig = await configStore.get("auth.providers", {
    scope: "global",
    scopeId: "global",
    fallback: {
      google: { enabled: Boolean(BOOTSTRAP_GOOGLE_CLIENT_ID), clientId: BOOTSTRAP_GOOGLE_CLIENT_ID || "" }
    }
  });
  const googleEnabled = Boolean(providerConfig?.google?.enabled);
  const googleClientId = String(providerConfig?.google?.clientId || BOOTSTRAP_GOOGLE_CLIENT_ID || "");
  const googleSecret = await repo.getSystemSecret("google.client_secret");
  const passwordResetEnabled = Boolean(
    emailSettings.enabled && emailSettings.host && emailSettings.username && emailSettings.password && emailSettings.fromAddress
  );
  res.json({
    ok: true,
    google: { enabled: googleEnabled && Boolean(googleClientId) && Boolean(googleSecret?.ciphertext), clientId: googleClientId || null },
    password: { enabled: true, resetEnabled: passwordResetEnabled }
  });
}));

app.get("/api/setup/status", withAsync(async (req, res) => {
  const status = await refreshConfigStatus({ force: true });
  res.json({
    ok: true,
    wizardCompleted: status?.overall !== "SETUP_REQUIRED",
    overall: status?.overall || "SETUP_REQUIRED",
    details: status?.details || [],
    setupRequired: status?.overall === "SETUP_REQUIRED",
    steps: {
      database: { ready: status?.required?.database === "READY", state: status?.required?.database || "MISSING" },
      smtp: { ready: status?.optional?.smtp === "READY", state: status?.optional?.smtp || "MISSING" },
      adminUser: { ready: status?.required?.adminUser === "READY", state: status?.required?.adminUser || "MISSING" },
      googleAuth: { ready: status?.optional?.googleAuth === "READY", state: status?.optional?.googleAuth || "MISSING" },
      openai: { ready: status?.optional?.openai === "READY", state: status?.optional?.openai || "MISSING" },
      languagePacks: { ready: status?.optional?.languagePacks === "READY", state: status?.optional?.languagePacks || "MISSING" }
    },
    configVersion: status?.config_version || 1
  });
}));

app.post("/api/setup/complete", requirePermission(Permissions.ADMIN_CONFIG_MANAGE), adminLimiter, withAsync(async (req, res) => {
  const status = await refreshConfigStatus({ force: true });
  if (status?.overall === "SETUP_REQUIRED") {
    throw new AppError("Required setup steps are incomplete", { status: 409, code: "SETUP_REQUIRED", expose: true });
  }
  await audit(req, "setup.complete", "wizard", "app", { overall: status?.overall });
  res.json({ ok: true, status });
}));

app.post("/api/setup/bootstrap-owner", requirePermission(Permissions.SESSION_READ), withAsync(async (req, res) => {
  if (!req.actor?.isAuthenticated || !req.actor?.id) {
    throw new AppError("Authentication required", { status: 401, code: "UNAUTHORIZED", expose: true });
  }
  const existingOwner = await repo.getOwnerUser();
  if (existingOwner) {
    throw new AppError("Owner already exists", { status: 409, code: "OWNER_EXISTS", expose: true });
  }
  const updated = await repo.updateUserRole(req.actor.id, Roles.OWNER);
  await audit(req, "setup.bootstrap_owner", "user", String(req.actor.id));
  await refreshConfigStatus({ force: true });
  res.json({ ok: true, owner: updated });
}));

app.post("/api/setup/admin-user", withAsync(async (req, res) => {
  if (!setupModeActive) {
    throw new AppError("Setup mode is not active", { status: 409, code: "SETUP_NOT_ACTIVE", expose: true });
  }
  const email = normalizeEmail(asString(req.body?.email || "", { min: 5, max: 255, field: "email" }));
  const displayName = asString(req.body?.displayName || email.split("@")[0] || "Admin", { min: 1, max: 64, field: "displayName" });
  const password = asString(req.body?.password || "", { min: 10, max: 128, field: "password" });
  const policy = validatePasswordPolicy(password);
  if (!policy.ok) throw badRequest(policy.message);

  let user = await repo.findUserByEmail(email);
  if (!user) {
    user = await repo.createUser({
      externalSubject: `password:${email}`,
      email,
      displayName,
      role: Roles.OWNER
    });
  } else if (![Roles.ADMIN, Roles.OWNER].includes(normalizeRole(user.role))) {
    user = await repo.updateUserRole(user.id, Roles.OWNER);
  }

  const passwordHash = await hashPassword(password);
  await upsertPasswordIdentity(repo, user.id, passwordHash);
  await repo.touchUserLogin(user.id);
  await audit(req, "setup.admin_user.create", "user", String(user.id), { email: user.email });
  const status = await refreshConfigStatus({ force: true });
  res.status(201).json({
    ok: true,
    setupRequired: status?.overall === "SETUP_REQUIRED",
    user: { id: user.id, email: user.email, displayName: user.displayName, role: user.role }
  });
}));

app.get("/api/setup/db-status", withAsync(async (req, res) => {
  let dbOk = false;
  let migration = null;
  try {
    await repo.ping();
    dbOk = true;
    migration = await getMigrationStatus(repo, activeDriver);
  } catch {
    dbOk = false;
  }
  res.json({
    ok: true,
    activeDriver,
    database: dbOk ? "READY" : "INVALID",
    migrations: migration || null
  });
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
  const displayName = asString(req.body?.displayName || "", { min: 1, max: 64, field: "displayName" }).trim();
  const existing = await repo.findUserByDisplayName(displayName);
  if (existing && Number(existing.id) !== Number(req.actor.id)) {
    throw new AppError("Display name is already taken", { status: 409, code: "DISPLAY_NAME_TAKEN", expose: true });
  }
  const avatarUrl = String(req.body?.avatarUrl || "");
  const user = await repo.updateUserProfile(req.actor.id, { displayName, avatarUrl });
  await audit(req, "user.profile.update", "user", String(req.actor.id));
  res.json({ ok: true, profile: user });
}));

app.get("/api/user/display-name/availability", requirePermission(Permissions.SESSION_READ), withAsync(async (req, res) => {
  if (!req.actor?.isAuthenticated) throw new AppError("Authentication required", { status: 401, code: "UNAUTHORIZED", expose: true });
  const displayName = asString(req.query.name || "", { min: 1, max: 64, field: "name" }).trim();
  const existing = await repo.findUserByDisplayName(displayName);
  const available = !existing || Number(existing.id) === Number(req.actor.id);
  res.json({ ok: true, available });
}));

app.put("/api/user/password", requirePermission(Permissions.SESSION_READ), authLimiter, withAsync(async (req, res) => {
  if (!req.actor?.isAuthenticated) throw new AppError("Authentication required", { status: 401, code: "UNAUTHORIZED", expose: true });
  const currentPassword = asString(req.body?.currentPassword || "", { min: 1, max: 128, field: "currentPassword" });
  const newPassword = asString(req.body?.newPassword || "", { min: 10, max: 128, field: "newPassword" });
  const policy = validatePasswordPolicy(newPassword);
  if (!policy.ok) throw badRequest(policy.message);
  if (currentPassword === newPassword) throw badRequest("New password must be different from current password");
  const identity = await getPasswordIdentityByEmail(repo, req.actor.email || "");
  const ok = await verifyPassword(currentPassword, identity?.passwordhash || identity?.passwordHash || "");
  if (!ok) {
    await audit(req, "user.password.change", "user", String(req.actor.id), { ok: false });
    throw new AppError("Current password is incorrect", { status: 400, code: "PASSWORD_INVALID", expose: true });
  }
  const passwordHash = await hashPassword(newPassword);
  await upsertPasswordIdentity(repo, req.actor.id, passwordHash);
  await repo.revokeAuthSessionsForUser(req.actor.id);
  const fresh = await repo.findUserById(req.actor.id);
  await issueSessionForUser(req, res, fresh, "user.password.change");
  await audit(req, "user.password.change", "user", String(req.actor.id), { ok: true });
  res.json({ ok: true });
}));

app.get("/api/user/openai-key/status", requirePermission(Permissions.SESSION_READ), withAsync(async (req, res) => {
  if (!req.actor?.isAuthenticated) return res.json({ ok: true, configured: false, source: null });
  const serviceSummary = summarizeOpenAIServiceStatus(await getOpenAIServiceConfig());
  const resolved = await resolveOpenAIExecutionContext(req.actor, { includeLegacy: true });
  res.json({
    ok: true,
    configured: Boolean(resolved?.apiKey),
    source: resolved?.source || null,
    storeInDb: serviceSummary.storeInDb,
    verified: Boolean(serviceSummary.lastTestOk),
    lastTestAt: serviceSummary.lastTestAt || null,
    lastTestError: serviceSummary.lastTestError || null,
    model: serviceSummary.model
  });
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

app.get("/api/user/preferences", requirePermission(Permissions.SESSION_READ), withAsync(async (req, res) => {
  if (!req.actor?.isAuthenticated) {
    return res.json({ ok: true, preferences: defaultGamePreferences(null), source: "guest_default" });
  }
  const existing = await repo.getGamePreferences(req.actor.id);
  const normalized = existing
    ? {
        userId: Number(existing.userid || existing.userId || req.actor.id),
        mode: existing.mode === "contest" ? "contest" : "learning",
        level: clampNumber(existing.level, 1, 5, 1),
        contentType: existing.contenttype || existing.contentType || "default",
        language: String(existing.language || "en").toLowerCase(),
        updatedAt: existing.updatedat || existing.updatedAt || new Date().toISOString()
      }
    : defaultGamePreferences(req.actor.id);
  res.json({ ok: true, preferences: normalized, source: existing ? "db" : "default" });
}));

app.put("/api/user/preferences", requirePermission(Permissions.SESSION_READ), withAsync(async (req, res) => {
  if (!req.actor?.isAuthenticated) throw new AppError("Authentication required", { status: 401, code: "UNAUTHORIZED", expose: true });
  const body = requireObject(req.body || {}, "preferences");
  const mode = body.mode === "contest" ? "contest" : "learning";
  const level = clampNumber(body.level, 1, 5, 1);
  const contentType = body.contentType === "vocab" ? "vocab" : "default";
  const language = String(body.language || "en").toLowerCase();
  const updatedAt = new Date().toISOString();
  await repo.upsertGamePreferences({
    userId: req.actor.id,
    mode,
    level,
    contentType,
    language,
    updatedAt
  });
  await audit(req, "user.preferences.update", "user", String(req.actor.id), { mode, level, contentType, language });
  res.json({
    ok: true,
    preferences: {
      userId: req.actor.id,
      mode,
      level,
      contentType,
      language,
      updatedAt
    }
  });
}));

app.get("/api/user/stats", requirePermission(Permissions.SESSION_READ), withAsync(async (req, res) => {
  if (!req.actor?.isAuthenticated) {
    return res.json({ ok: true, stats: null, source: "guest" });
  }
  const row = await repo.getPlayerStats(req.actor.id);
  const stats = row
    ? {
        userId: Number(row.userid || row.userId || req.actor.id),
        totalLettersTyped: Number(row.totalletterstyped || row.totalLettersTyped || 0),
        totalCorrect: Number(row.totalcorrect || row.totalCorrect || 0),
        totalIncorrect: Number(row.totalincorrect || row.totalIncorrect || 0),
        bestWPM: Number(row.bestwpm || row.bestWPM || 0),
        sessionsCount: Number(row.sessionscount || row.sessionsCount || 0),
        totalPlayTimeMs: Number(row.totalplaytimems || row.totalPlayTimeMs || 0),
        streakDays: Number(row.streakdays || row.streakDays || 0),
        lastSessionAt: row.lastsessionat || row.lastSessionAt || null
      }
    : {
        userId: req.actor.id,
        totalLettersTyped: 0,
        totalCorrect: 0,
        totalIncorrect: 0,
        bestWPM: 0,
        sessionsCount: 0,
        totalPlayTimeMs: 0,
        streakDays: 0,
        lastSessionAt: null
      };
  res.json({ ok: true, stats, source: row ? "db" : "default" });
}));

app.post("/api/user/stats/session-end", requirePermission(Permissions.SESSION_READ), withAsync(async (req, res) => {
  if (!req.actor?.isAuthenticated) return res.json({ ok: true, saved: false, reason: "guest" });
  const body = requireObject(req.body || {}, "sessionStats");
  const lettersTyped = clampNumber(body.lettersTyped, 0, 5_000_000, 0);
  const correct = clampNumber(body.correct, 0, 5_000_000, 0);
  const incorrect = clampNumber(body.incorrect, 0, 5_000_000, 0);
  const bestWPMSession = clampNumber(body.bestWPM, 0, 100_000, 0);
  const playTimeMs = clampNumber(body.totalPlayTimeMs, 0, 86_400_000, 0);
  const sessionEndedAt = new Date(body.lastSessionAt || Date.now()).toISOString();

  const existing = await repo.getPlayerStats(req.actor.id);
  const prior = existing
    ? {
        totalLettersTyped: Number(existing.totalletterstyped || existing.totalLettersTyped || 0),
        totalCorrect: Number(existing.totalcorrect || existing.totalCorrect || 0),
        totalIncorrect: Number(existing.totalincorrect || existing.totalIncorrect || 0),
        bestWPM: Number(existing.bestwpm || existing.bestWPM || 0),
        sessionsCount: Number(existing.sessionscount || existing.sessionsCount || 0),
        totalPlayTimeMs: Number(existing.totalplaytimems || existing.totalPlayTimeMs || 0),
        streakDays: Number(existing.streakdays || existing.streakDays || 0),
        lastSessionAt: existing.lastsessionat || existing.lastSessionAt || null
      }
    : {
        totalLettersTyped: 0,
        totalCorrect: 0,
        totalIncorrect: 0,
        bestWPM: 0,
        sessionsCount: 0,
        totalPlayTimeMs: 0,
        streakDays: 0,
        lastSessionAt: null
      };

  const currentDay = normalizeDateKey(sessionEndedAt);
  const previousDay = normalizeDateKey(prior.lastSessionAt);
  let streakDays = prior.streakDays || 0;
  if (!previousDay) {
    streakDays = 1;
  } else {
    const diff = dayDiffUtc(currentDay, previousDay);
    if (diff <= 0) streakDays = Math.max(1, streakDays || 1);
    else if (diff === 1) streakDays += 1;
    else streakDays = 1;
  }

  const next = {
    userId: req.actor.id,
    totalLettersTyped: prior.totalLettersTyped + lettersTyped,
    totalCorrect: prior.totalCorrect + correct,
    totalIncorrect: prior.totalIncorrect + incorrect,
    bestWPM: Math.max(prior.bestWPM, bestWPMSession),
    sessionsCount: prior.sessionsCount + 1,
    totalPlayTimeMs: prior.totalPlayTimeMs + playTimeMs,
    streakDays,
    lastSessionAt: sessionEndedAt
  };
  await repo.upsertPlayerStats(next);
  await audit(req, "user.stats.session_end", "user", String(req.actor.id), {
    lettersTyped,
    correct,
    incorrect,
    bestWPMSession,
    playTimeMs
  });
  res.json({ ok: true, saved: true, stats: next });
}));

app.post("/api/tasks/generate", requirePermission(Permissions.TASKS_GENERATE), requireNotMaintenance, generationLimiter, withAsync(async (req, res) => {
  const body = requireObject(req.body || {}, "body");
  const actorIsAuthorized = Boolean(req.actor?.isAuthenticated);
  const maxLevel = actorIsAuthorized ? 5 : 3;
  const safeLevel = asNumber(body.level, { min: 1, max: maxLevel, field: "level" });
  const safeCount = asNumber(body.count ?? 10, { min: 5, max: 100, field: "count" });
  const safeContentMode = body.contentMode === "vocab" ? "vocab" : "default";
  const requestedLanguage = String(body.language || "en").toLowerCase();
  const telemetry = body.telemetry && typeof body.telemetry === "object" ? body.telemetry : {};
  const sessionId = normalizeGameSessionId(body.sessionId, req.actor, req.ip);
  const languages = safeContentMode === "vocab"
    ? await repo.listPublishedLanguagesByType(safeLevel === 2 ? "level2" : safeLevel === 3 ? "level3" : "sentence_words")
    : await (async () => {
      const type = getVocabularyTypeForLevel(safeLevel);
      const packResult = await repo.listVocabularyPacks({ level: safeLevel, type, status: "published" }, {
        page: 1,
        pageSize: 500,
        sortBy: "updated_at",
        sortDir: "desc"
      });
      const dynamic = Array.isArray(packResult?.rows)
        ? packResult.rows.map((row) => String(row.language || "").toLowerCase()).filter(Boolean)
        : [];
      return Array.from(new Set(["en", "ru", ...dynamic]));
    })();
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
  const tasks = await generateTasks(safeLevel, safeCount, safeContentMode, language, {
    sessionId,
    telemetry: {
      cpm: clampNumber(telemetry.cpm, 0, 10_000, 0)
    },
    actor: req.actor,
    ip: req.ip,
    requestId: req.requestId || null
  });
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
  const raw = req.query || {};
  const contestType = raw.contestType === "tasks" ? "tasks" : "time";
  const level = clampNumber(raw.level, 1, 5, 1);
  const contentMode = raw.contentMode === "vocab" ? "vocab" : "default";
  const duration = contestType === "time" ? clampNumber(raw.duration, 30, 120, 60) : null;
  const taskTarget = contestType === "tasks" ? clampNumber(raw.taskTarget, 10, 50, 20) : null;
  const language = raw.language ? String(raw.language).toLowerCase() : "";
  const sortBy = ["score", "accuracy", "cpm", "date", "createdAt"].includes(String(raw.sort || "")) ? String(raw.sort) : "score";
  const sortDir = String(raw.order || "desc").toLowerCase() === "asc" ? "asc" : "desc";
  const page = clampNumber(raw.page, 1, 5000, 1);
  const pageSize = clampNumber(raw.pageSize, 5, 100, 20);
  const dateRange = String(raw.dateRange || "all");
  const createdAfter = dateRange === "7d"
    ? new Date(Date.now() - 7 * 86400000).toISOString()
    : dateRange === "30d"
      ? new Date(Date.now() - 30 * 86400000).toISOString()
      : "";

  const filters = {
    contestType,
    level,
    contentMode,
    duration,
    taskTarget,
    language,
    createdAfter,
    onlyAuthorized: true
  };
  const options = { sortBy, sortDir, page, pageSize };
  const pageResult = repo.queryLeaderboardPage
    ? await repo.queryLeaderboardPage(filters, options)
    : { rows: await repo.queryLeaderboard(filters), total: 0, page, pageSize };
  const rows = pageResult.rows || [];
  const total = Number(pageResult.total || rows.length);

  let myRank = null;
  if (req.actor?.isAuthenticated) {
    const idx = rows.findIndex((entry) => Number(entry.userid || entry.userId) === Number(req.actor.id));
    if (idx >= 0) myRank = (page - 1) * pageSize + idx + 1;
  }
  res.json({ rows, total, page, pageSize, myRank, entries: rows });
}));

app.get("/api/packs/languages", requirePermission(Permissions.TASKS_GENERATE), withAsync(async (req, res) => {
  const level = asNumber(req.query.level || 2, { min: 1, max: 5, field: "level" });
  const contentMode = req.query.contentMode === "vocab" ? "vocab" : "default";
  if (contentMode === "vocab") {
    const type = level === 2 ? "level2" : level === 3 ? "level3" : "sentence_words";
    const languages = await repo.listPublishedLanguagesByType(type);
    return res.json({ ok: true, level, type, contentMode, languages });
  }
  const vocabType = getVocabularyTypeForLevel(level);
  const packResult = await repo.listVocabularyPacks({
    level,
    type: vocabType,
    status: "published"
  }, {
    page: 1,
    pageSize: 500,
    sortBy: "updated_at",
    sortDir: "desc"
  });
  const dynamic = Array.isArray(packResult?.rows)
    ? packResult.rows.map((row) => String(row.language || "").toLowerCase()).filter(Boolean)
    : [];
  const languages = Array.from(new Set(["en", "ru", ...dynamic])).sort();
  return res.json({ ok: true, level, type: vocabType, contentMode, languages });
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
  const openaiCtx = await resolveOpenAIExecutionContext(req.actor, { includeLegacy: true });
  if (!openaiCtx?.apiKey) throw badRequest("OpenAI key is required for generation");
  const language = asString(req.body?.language || "en", { min: 2, max: 10, field: "language" }).toLowerCase();
  const type = asEnum(req.body?.type || "level2", ["level2", "level3", "sentence_words"], "type");
  const count = asNumber(req.body?.count || 30, { min: 5, max: 200, field: "count" });
  const topic = String(req.body?.topic || "general toddler-safe learning");
  const prompt = strictPrompt({ language, type, count, topic });
  const output = await callOpenAI({ apiKey: openaiCtx.apiKey, model: openaiCtx.model || OPENAI_MODEL, prompt });
  const parsed = JSON.parse(output);
  const items = parseJsonArrayOfStrings(parsed.items || [], "items", 500);
  const packId = await repo.createLanguagePack({ language, type, topic, status: "DRAFT", createdBy: req.actor.id });
  await repo.replaceLanguagePackItems(packId, items.map((text) => ({ text, difficulty: null, metadataJson: { source: "openai" } })));
  await audit(req, "language_pack.generate", "pack", String(packId), { language, type, count: items.length });
  res.json({ ok: true, packId, status: "DRAFT", count: items.length });
}));

app.get("/api/admin/vocabulary/generator/status", requirePermission(Permissions.VOCAB_MANAGE), adminLimiter, withAsync(async (req, res) => {
  const serviceConfig = await getOpenAIServiceConfig();
  const summary = summarizeOpenAIServiceStatus(serviceConfig);
  const resolved = await resolveOpenAIExecutionContext(req.actor, { includeLegacy: true });
  res.json({
    ok: true,
    enabled: Boolean(resolved?.apiKey),
    configured: summary.configured || Boolean(resolved?.apiKey),
    source: resolved?.source || null,
    defaultModel: String(summary.model || OPENAI_MODEL),
    verified: Boolean(summary.lastTestOk),
    lastTestAt: summary.lastTestAt || null,
    lastTestError: summary.lastTestError || null
  });
}));

app.get("/api/admin/vocabulary/tree", requirePermission(Permissions.VOCAB_MANAGE), adminLimiter, withAsync(async (req, res) => {
  const language = req.query.language ? String(req.query.language).toLowerCase() : "";
  const status = req.query.status ? String(req.query.status).toLowerCase() : "";
  const packs = await repo.listVocabularyPacks({ language, status }, { page: 1, pageSize: 5000, sortBy: "updated_at", sortDir: "desc" });
  const tree = {};
  for (const row of packs.rows || []) {
    const lang = String(row.language || "en").toUpperCase();
    const levelKey = `Level ${Number(row.level || 1)}`;
    tree[lang] = tree[lang] || {};
    tree[lang][levelKey] = tree[lang][levelKey] || [];
    tree[lang][levelKey].push({
      id: row.id,
      name: row.name,
      status: normalizeVocabularyStatus(row.status),
      version: Number(row.version || 1),
      type: normalizeVocabularyType(row.type),
      updatedAt: row.updated_at || row.updatedAt
    });
  }
  res.json({ ok: true, tree });
}));

app.get("/api/admin/vocabulary/packs", requirePermission(Permissions.VOCAB_MANAGE), adminLimiter, withAsync(async (req, res) => {
  const filters = {
    language: req.query.language ? String(req.query.language).toLowerCase() : "",
    level: req.query.level ? clampNumber(req.query.level, 1, 5, 1) : 0,
    type: req.query.type ? normalizeVocabularyType(req.query.type) : "",
    status: req.query.status ? normalizeVocabularyStatus(req.query.status) : "",
    source: req.query.source ? String(req.query.source).toLowerCase() : "",
    search: req.query.search ? String(req.query.search) : ""
  };
  const options = {
    sortBy: req.query.sort ? String(req.query.sort) : "updated_at",
    sortDir: req.query.order ? String(req.query.order) : "desc",
    page: clampNumber(req.query.page, 1, 10000, 1),
    pageSize: clampNumber(req.query.pageSize, 5, 100, 20)
  };
  const result = await repo.listVocabularyPacks(filters, options);
  const rows = (result.rows || []).map((row) => ({
    id: row.id,
    name: row.name,
    language: String(row.language || "en").toLowerCase(),
    level: Number(row.level || 1),
    type: normalizeVocabularyType(row.type),
    status: normalizeVocabularyStatus(row.status),
    source: String(row.source || "manual").toLowerCase(),
    version: Number(row.version || 1),
    generator_config: typeof row.generator_config === "string" ? safeParseJson(row.generator_config, null) : (row.generator_config || null),
    metadata: typeof row.metadata === "string" ? safeParseJson(row.metadata, null) : (row.metadata || null),
    created_at: row.created_at || row.createdAt,
    updated_at: row.updated_at || row.updatedAt
  }));
  res.json({ ok: true, rows, total: Number(result.total || rows.length), page: Number(result.page || options.page), pageSize: Number(result.pageSize || options.pageSize) });
}));

app.get("/api/admin/vocabulary/packs/:id", requirePermission(Permissions.VOCAB_MANAGE), adminLimiter, withAsync(async (req, res) => {
  const id = String(req.params.id || "");
  const pack = await repo.getVocabularyPackById(id);
  if (!pack) throw new AppError("Not found", { status: 404, code: "NOT_FOUND", expose: true });
  const entries = await repo.listVocabularyEntries(id);
  const versions = await repo.listVocabularyVersions(id);
  res.json({
    ok: true,
    pack: {
      ...pack,
      type: normalizeVocabularyType(pack.type),
      status: normalizeVocabularyStatus(pack.status),
      generator_config: typeof pack.generator_config === "string" ? safeParseJson(pack.generator_config, null) : pack.generator_config,
      metadata: typeof pack.metadata === "string" ? safeParseJson(pack.metadata, null) : pack.metadata
    },
    entries,
    versions
  });
}));

app.post("/api/admin/vocabulary/packs", requirePermission(Permissions.VOCAB_MANAGE), adminLimiter, withAsync(async (req, res) => {
  const body = requireObject(req.body || {}, "body");
  const now = new Date().toISOString();
  const id = randomUUID();
  const pack = {
    id,
    name: asString(body.name || "Untitled Pack", { min: 2, max: 120, field: "name" }),
    language: asString(body.language || "en", { min: 2, max: 10, field: "language" }).toLowerCase(),
    level: asNumber(body.level || 1, { min: 1, max: 5, field: "level" }),
    type: normalizeVocabularyType(body.type),
    status: normalizeVocabularyStatus(body.status || "draft"),
    source: normalizeVocabularySource(body.source || "manual"),
    version: 1,
    generator_config: body.generator_config || null,
    metadata: body.metadata || null,
    created_at: now,
    updated_at: now
  };
  const entries = Array.isArray(body.entries) ? body.entries : [];
  await repo.createVocabularyPack(pack);
  await repo.replaceVocabularyEntries(id, entries.map((entry, idx) => ({
    id: randomUUID(),
    text: String(entry.text || "").trim(),
    order_index: idx,
    difficulty_score: entry.difficulty_score ?? null,
    tags: entry.tags || null,
    created_at: now
  })).filter((e) => e.text));
  const versionSnapshot = {
    pack,
    entries: await repo.listVocabularyEntries(id)
  };
  await repo.createVocabularyVersion({
    id: randomUUID(),
    pack_id: id,
    version: 1,
    snapshot_json: versionSnapshot,
    change_note: "initial create",
    created_by: String(req.actor?.id || ""),
    created_at: now
  });
  await audit(req, "vocabulary.pack.create", "vocabulary_pack", id, { language: pack.language, level: pack.level, type: pack.type, status: pack.status });
  res.json({ ok: true, id });
}));

app.put("/api/admin/vocabulary/packs/:id", requirePermission(Permissions.VOCAB_MANAGE), adminLimiter, withAsync(async (req, res) => {
  const id = String(req.params.id || "");
  const body = requireObject(req.body || {}, "body");
  const existing = await repo.getVocabularyPackById(id);
  if (!existing) throw new AppError("Not found", { status: 404, code: "NOT_FOUND", expose: true });
  const nextVersion = Number(existing.version || 1) + 1;
  const patch = {
    name: body.name ? asString(body.name, { min: 2, max: 120, field: "name" }) : existing.name,
    language: body.language ? asString(body.language, { min: 2, max: 10, field: "language" }).toLowerCase() : existing.language,
    level: body.level ? asNumber(body.level, { min: 1, max: 5, field: "level" }) : existing.level,
    type: body.type ? normalizeVocabularyType(body.type) : existing.type,
    status: body.status ? normalizeVocabularyStatus(body.status) : existing.status,
    source: body.source ? normalizeVocabularySource(body.source) : normalizeVocabularySource(existing.source),
    generator_config: body.generator_config !== undefined ? body.generator_config : safeParseJson(existing.generator_config, null),
    metadata: body.metadata !== undefined ? body.metadata : safeParseJson(existing.metadata, null),
    version: nextVersion
  };
  await repo.updateVocabularyPack(id, patch);
  if (Array.isArray(body.entries)) {
    const now = new Date().toISOString();
    await repo.replaceVocabularyEntries(id, body.entries.map((entry, idx) => ({
      id: entry.id || randomUUID(),
      text: String(entry.text || "").trim(),
      order_index: idx,
      difficulty_score: entry.difficulty_score ?? null,
      tags: entry.tags || null,
      created_at: entry.created_at || now
    })).filter((e) => e.text));
  }
  const snapshot = {
    pack: await repo.getVocabularyPackById(id),
    entries: await repo.listVocabularyEntries(id)
  };
  await repo.createVocabularyVersion({
    id: randomUUID(),
    pack_id: id,
    version: nextVersion,
    snapshot_json: snapshot,
    change_note: String(body.change_note || "edited"),
    created_by: String(req.actor?.id || ""),
    created_at: new Date().toISOString()
  });
  await audit(req, "vocabulary.pack.update", "vocabulary_pack", id, { version: nextVersion });
  res.json({ ok: true });
}));

app.post("/api/admin/vocabulary/packs/:id/publish", requirePermission(Permissions.VOCAB_MANAGE), adminLimiter, withAsync(async (req, res) => {
  const id = String(req.params.id || "");
  const pack = await repo.getVocabularyPackById(id);
  if (!pack) throw new AppError("Not found", { status: 404, code: "NOT_FOUND", expose: true });
  await repo.updateVocabularyPack(id, { status: "published", version: Number(pack.version || 1) + 1 });
  await audit(req, "vocabulary.pack.publish", "vocabulary_pack", id);
  res.json({ ok: true });
}));

app.post("/api/admin/vocabulary/packs/:id/unpublish", requirePermission(Permissions.VOCAB_MANAGE), adminLimiter, withAsync(async (req, res) => {
  const id = String(req.params.id || "");
  const pack = await repo.getVocabularyPackById(id);
  if (!pack) throw new AppError("Not found", { status: 404, code: "NOT_FOUND", expose: true });
  await repo.updateVocabularyPack(id, { status: "draft", version: Number(pack.version || 1) + 1 });
  await audit(req, "vocabulary.pack.unpublish", "vocabulary_pack", id);
  res.json({ ok: true });
}));

app.post("/api/admin/vocabulary/packs/:id/rollback", requirePermission(Permissions.VOCAB_MANAGE), adminLimiter, withAsync(async (req, res) => {
  const id = String(req.params.id || "");
  const targetVersion = asNumber(req.body?.version || 0, { min: 1, max: 100000, field: "version" });
  const versions = await repo.listVocabularyVersions(id);
  const selected = versions.find((v) => Number(v.version) === Number(targetVersion));
  if (!selected) throw new AppError("Version not found", { status: 404, code: "NOT_FOUND", expose: true });
  const snap = selected.snapshot_json || {};
  if (!snap.pack) throw new AppError("Snapshot invalid", { status: 400, code: "INVALID_SNAPSHOT", expose: true });
  await repo.updateVocabularyPack(id, {
    name: snap.pack.name,
    language: snap.pack.language,
    level: snap.pack.level,
    type: normalizeVocabularyType(snap.pack.type),
    status: normalizeVocabularyStatus(snap.pack.status || "draft"),
    source: snap.pack.source || "manual",
    generator_config: snap.pack.generator_config || null,
    metadata: snap.pack.metadata || null,
    version: Number((await repo.getVocabularyPackById(id)).version || 1) + 1
  });
  const now = new Date().toISOString();
  await repo.replaceVocabularyEntries(id, (snap.entries || []).map((entry, idx) => ({
    id: randomUUID(),
    text: String(entry.text || "").trim(),
    order_index: idx,
    difficulty_score: entry.difficulty_score ?? null,
    tags: entry.tags || null,
    created_at: now
  })).filter((e) => e.text));
  await audit(req, "vocabulary.pack.rollback", "vocabulary_pack", id, { version: targetVersion });
  res.json({ ok: true });
}));

app.delete("/api/admin/vocabulary/packs/:id", requirePermission(Permissions.VOCAB_MANAGE), adminLimiter, withAsync(async (req, res) => {
  const id = String(req.params.id || "");
  await repo.deleteVocabularyPack(id);
  await audit(req, "vocabulary.pack.delete", "vocabulary_pack", id);
  res.json({ ok: true });
}));

app.get("/api/admin/vocabulary/packs/:id/export", requirePermission(Permissions.VOCAB_MANAGE), adminLimiter, withAsync(async (req, res) => {
  const id = String(req.params.id || "");
  const pack = await repo.getVocabularyPackById(id);
  if (!pack) throw new AppError("Not found", { status: 404, code: "NOT_FOUND", expose: true });
  const entries = await repo.listVocabularyEntries(id);
  const payload = {
    pack: {
      ...pack,
      generator_config: typeof pack.generator_config === "string" ? safeParseJson(pack.generator_config, null) : pack.generator_config,
      metadata: typeof pack.metadata === "string" ? safeParseJson(pack.metadata, null) : pack.metadata
    },
    entries
  };
  res.json({ ok: true, payload });
}));

app.post("/api/admin/vocabulary/import", requirePermission(Permissions.VOCAB_MANAGE), adminLimiter, withAsync(async (req, res) => {
  const body = requireObject(req.body || {}, "body");
  const payload = requireObject(body.payload || {}, "payload");
  const incomingPack = requireObject(payload.pack || {}, "pack");
  const now = new Date().toISOString();
  const id = randomUUID();
  const pack = {
    id,
    name: asString(incomingPack.name || "Imported Pack", { min: 2, max: 120, field: "name" }),
    language: asString(incomingPack.language || "en", { min: 2, max: 10, field: "language" }).toLowerCase(),
    level: asNumber(incomingPack.level || 1, { min: 1, max: 5, field: "level" }),
    type: normalizeVocabularyType(incomingPack.type),
    status: normalizeVocabularyStatus(incomingPack.status || "draft"),
    source: "imported",
    version: 1,
    generator_config: incomingPack.generator_config || null,
    metadata: incomingPack.metadata || null,
    created_at: now,
    updated_at: now
  };
  const entries = Array.isArray(payload.entries) ? payload.entries : [];
  await repo.createVocabularyPack(pack);
  await repo.replaceVocabularyEntries(id, entries.map((entry, idx) => ({
    id: randomUUID(),
    text: String(entry.text || "").trim(),
    order_index: idx,
    difficulty_score: entry.difficulty_score ?? null,
    tags: entry.tags || null,
    created_at: now
  })).filter((e) => e.text));
  await repo.createVocabularyVersion({
    id: randomUUID(),
    pack_id: id,
    version: 1,
    snapshot_json: { pack, entries: await repo.listVocabularyEntries(id) },
    change_note: "import",
    created_by: String(req.actor?.id || ""),
    created_at: now
  });
  await audit(req, "vocabulary.pack.import", "vocabulary_pack", id, { source: "imported" });
  res.json({ ok: true, id });
}));

app.post("/api/admin/vocabulary/packs/:id/regenerate", requirePermission(Permissions.VOCAB_MANAGE), adminLimiter, generationLimiter, withAsync(async (req, res) => {
  const id = String(req.params.id || "");
  const pack = await repo.getVocabularyPackById(id);
  if (!pack) throw new AppError("Not found", { status: 404, code: "NOT_FOUND", expose: true });
  const openaiCtx = await resolveOpenAIExecutionContext(req.actor, { includeLegacy: true });
  if (!openaiCtx?.apiKey) throw new AppError("OpenAI key missing", { status: 400, code: "OPENAI_KEY_MISSING", expose: true });
  const body = requireObject(req.body || {}, "body");
  const count = asNumber(body.count || 30, { min: 5, max: 500, field: "count" });
  const model = asString(body.model || openaiCtx.model || OPENAI_MODEL, { min: 3, max: 120, field: "model" });
  const temperature = clampNumber(body.temperature ?? 0.5, 0, 1.2, 0.5);
  const maxTokens = clampNumber(body.max_tokens ?? 1200, 128, 4000, 1200);
  const promptTemplate = String(body.prompt_template || "").trim();
  const prompts = buildVocabularyGenerationPrompts({
    language: String(pack.language || "en"),
    level: Number(pack.level || 1),
    type: normalizeVocabularyType(pack.type),
    count,
    theme: body.theme || ""
  });
  const promptToRun = promptTemplate || prompts.developer;

  let output = "";
  let parsedItems = [];
  let parseError = "";
  const minRequired = Math.max(3, Math.floor(count * 0.6));
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    output = await callOpenAI({
      apiKey: openaiCtx.apiKey,
      model,
      temperature,
      maxTokens,
      systemPrompt: prompts.system,
      prompt: attempt === 1
        ? promptToRun
        : `Convert the following text into a valid JSON array of strings only. Do not add commentary.\n\n${output}`
    });
    parsedItems = safeParseJsonArrayOfStrings(output, count);
    if (parsedItems.length >= minRequired) break;
    parseError = `Attempt ${attempt}: expected at least ${minRequired} items, got ${parsedItems.length}.`;
  }
  const validated = validateGeneratedVocabularyItems(parsedItems, {
    type: normalizeVocabularyType(pack.type),
    level: Number(pack.level || 1),
    language: String(pack.language || "en")
  });
  if (validated.items.length < minRequired) {
    const diagnostics = {
      at: new Date().toISOString(),
      requestId: req.requestId || null,
      code: "GEN_INVALID_OUTPUT",
      message: parseError || "Generator output is invalid JSON items array",
      parsedCount: parsedItems.length,
      validatedCount: validated.items.length,
      outputPreview: String(output || "").slice(0, 2000),
      model,
      requestedCount: count
    };
    await repo.updateVocabularyPack(id, {
      metadata: {
        ...(safeParseJson(pack.metadata, {}) || {}),
        generation_last: diagnostics
      }
    });
    throw new AppError("Generator output is invalid JSON items array", {
      status: 400,
      code: "GEN_INVALID_OUTPUT",
      expose: true,
      metadata: { requestId: req.requestId, parsedCount: parsedItems.length, minRequired }
    });
  }
  const now = new Date().toISOString();
  const priorMetadata = typeof pack.metadata === "string" ? safeParseJson(pack.metadata, {}) : (pack.metadata || {});
  const generationLast = {
    at: now,
    requestId: req.requestId || null,
    code: "OK",
    message: "",
    requestedCount: count,
    parsedCount: parsedItems.length,
    validatedCount: validated.items.length,
    model,
    outputPreview: String(output || "").slice(0, 2000),
    parsedPreview: validated.items.slice(0, 15)
  };
  await repo.updateVocabularyPack(id, {
    source: "openai",
    version: Number(pack.version || 1) + 1,
    generator_config: {
      model,
      prompt_template: promptTemplate,
      temperature,
      max_tokens: maxTokens,
      theme: body.theme || null,
      random_seed: body.random_seed || null,
      advanced: body.advanced || null
    },
    metadata: {
      ...(priorMetadata || {}),
      generation_last: generationLast
    }
  });
  await repo.replaceVocabularyEntries(id, validated.items.map((text, idx) => ({
    id: randomUUID(),
    text: String(text || "").trim(),
    order_index: idx,
    difficulty_score: null,
    tags: null,
    created_at: now
  })).filter((e) => e.text));
  await repo.createVocabularyVersion({
    id: randomUUID(),
    pack_id: id,
    version: Number(pack.version || 1) + 1,
    snapshot_json: {
      pack: await repo.getVocabularyPackById(id),
      entries: await repo.listVocabularyEntries(id)
    },
    change_note: "regenerate draft",
    created_by: String(req.actor?.id || ""),
    created_at: now
  });
  await audit(req, "vocabulary.pack.regenerate", "vocabulary_pack", id, { count });
  res.json({ ok: true, count: validated.items.length, requestId: req.requestId || null });
}));

app.post("/api/admin/vocabulary/packs/batch", requirePermission(Permissions.VOCAB_MANAGE), adminLimiter, generationLimiter, withAsync(async (req, res) => {
  const body = requireObject(req.body || {}, "body");
  const action = asEnum(body.action || "", ["publish", "unpublish", "delete", "export", "regenerate"], "action");
  const ids = Array.isArray(body.ids) ? body.ids.map((id) => String(id || "").trim()).filter(Boolean) : [];
  if (!ids.length) throw new AppError("No pack IDs provided", { status: 400, code: "BATCH_EMPTY", expose: true });
  if (ids.length > 100) throw new AppError("Batch size too large", { status: 400, code: "BATCH_TOO_LARGE", expose: true });
  const results = [];
  const count = clampNumber(body.count ?? 30, 5, 500, 30);
  const batchOpenAICtx = action === "regenerate"
    ? await resolveOpenAIExecutionContext(req.actor, { includeLegacy: true })
    : null;
  for (const id of ids) {
    try {
      if (action === "publish") await repo.updateVocabularyPack(id, { status: "published" });
      if (action === "unpublish") await repo.updateVocabularyPack(id, { status: "draft" });
      if (action === "delete") await repo.deleteVocabularyPack(id);
      if (action === "export") {
        const pack = await repo.getVocabularyPackById(id);
        if (!pack) throw new Error("Not found");
        const entries = await repo.listVocabularyEntries(id);
        results.push({ id, ok: true, payload: { pack, entries } });
        continue;
      }
      if (action === "regenerate") {
        const pack = await repo.getVocabularyPackById(id);
        if (!pack) throw new Error("Not found");
        if (!batchOpenAICtx?.apiKey) throw new Error("OpenAI key missing");
        const prompts = buildVocabularyGenerationPrompts({
          language: String(pack.language || "en"),
          level: Number(pack.level || 1),
          type: normalizeVocabularyType(pack.type),
          count,
          theme: body.theme || ""
        });
        const output = await callOpenAI({
          apiKey: batchOpenAICtx.apiKey,
          model: batchOpenAICtx.model || OPENAI_MODEL,
          systemPrompt: prompts.system,
          prompt: prompts.developer
        });
        const parsedItems = safeParseJsonArrayOfStrings(output, count);
        const validated = validateGeneratedVocabularyItems(parsedItems, {
          type: normalizeVocabularyType(pack.type),
          level: Number(pack.level || 1),
          language: String(pack.language || "en")
        });
        if (!validated.items.length) throw new Error("No valid generated items");
        await repo.updateVocabularyPack(id, {
          source: "openai",
          version: Number(pack.version || 1) + 1,
          metadata: {
            ...(typeof pack.metadata === "string" ? safeParseJson(pack.metadata, {}) : (pack.metadata || {})),
            generation_last: {
              at: new Date().toISOString(),
              requestId: req.requestId || null,
              code: "OK",
              parsedCount: parsedItems.length,
              validatedCount: validated.items.length,
              outputPreview: String(output || "").slice(0, 2000)
            }
          }
        });
        await repo.replaceVocabularyEntries(id, validated.items.map((text, idx) => ({
          id: randomUUID(),
          text,
          order_index: idx,
          difficulty_score: null,
          tags: null,
          created_at: new Date().toISOString()
        })));
      }
      results.push({ id, ok: true });
    } catch (err) {
      results.push({ id, ok: false, error: String(err?.message || err || "Unknown error") });
    }
  }
  await audit(req, "vocabulary.pack.batch", "vocabulary_pack", action, { count: ids.length, action });
  res.json({ ok: true, action, results, requestId: req.requestId || null });
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

  const rawApiKey = String(body.apiKey || "").trim();
  if (rawApiKey) {
    await applyOpenAIServiceSettings({
      actor: req.actor,
      apiKey: rawApiKey,
      storeKey: Boolean(body.storeKey),
      enabled: true,
      model: body.model || OPENAI_MODEL
    });
  }
  const openaiCtx = rawApiKey
    ? { apiKey: rawApiKey, source: body.storeKey ? "service.openai.db" : "service.openai.ephemeral", model: OPENAI_MODEL }
    : await resolveOpenAIExecutionContext(req.actor, { includeLegacy: true });
  if (!openaiCtx?.apiKey) throw badRequest("OpenAI key required");

  const words = await generateWithRetry({ apiKey: openaiCtx.apiKey, packType: safeType, count: safeCount });
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
  const rawApiKey = String(body.apiKey || "").trim();
  if (rawApiKey || body.storeKey !== undefined || body.enabled !== undefined || body.model) {
    await applyOpenAIServiceSettings({
      actor: req.actor,
      apiKey: rawApiKey || null,
      storeKey: body.storeKey === undefined ? undefined : Boolean(body.storeKey),
      enabled: body.enabled === undefined ? undefined : Boolean(body.enabled),
      model: body.model ? String(body.model) : undefined
    });
  }
  try {
    const result = await runOpenAIConnectivityTest(req.actor, req.requestId || null);
    await persistOpenAITestStatus({ ok: true, code: "ok", errorMessage: null });
    await audit(req, "secret.openai.test", "secret", "service.openai", {
      source: result.source,
      model: result.model,
      requestId: result.requestId
    });
    return res.json(result);
  } catch (err) {
    const classified = classifyOpenAITestError(err);
    await persistOpenAITestStatus({ ok: false, code: classified.code, errorMessage: classified.message });
    throw new AppError(classified.message, {
      status: err?.status && Number(err.status) >= 400 ? Number(err.status) : 400,
      code: "OPENAI_TEST_FAILED",
      expose: true,
      metadata: {
        requestId: req.requestId || null,
        reason: classified.code
      }
    });
  }
}));

app.get("/api/admin/service/openai/status", requirePermission(Permissions.ADMIN_SECRET_MANAGE), adminLimiter, withAsync(async (req, res) => {
  const serviceConfig = await getOpenAIServiceConfig();
  const summary = summarizeOpenAIServiceStatus(serviceConfig);
  const resolved = await resolveOpenAIExecutionContext(req.actor, { includeLegacy: true });
  const ephemeralActive = Boolean(getOpenAIEphemeralKey(req.actor)?.apiKey);
  res.json({
    ok: true,
    status: {
      ...summary,
      configured: Boolean(resolved?.apiKey) || Boolean(summary.configured),
      activeSource: resolved?.source || (summary.storeInDb ? (summary.configured ? "service.openai.db" : null) : (ephemeralActive ? "service.openai.ephemeral" : null)),
      persisted: summary.storeInDb && summary.configured,
      requestId: req.requestId || null
    }
  });
}));

app.post("/api/admin/service/openai", requirePermission(Permissions.ADMIN_SECRET_MANAGE), adminLimiter, withAsync(async (req, res) => {
  const body = requireObject(req.body || {}, "body");
  const apiKey = body.apiKey === undefined ? undefined : String(body.apiKey || "");
  const status = await applyOpenAIServiceSettings({
    actor: req.actor,
    apiKey,
    storeKey: body.storeKey === undefined ? undefined : Boolean(body.storeKey),
    enabled: body.enabled === undefined ? undefined : Boolean(body.enabled),
    model: body.model ? String(body.model) : undefined
  });
  await audit(req, "service.openai.update", "config", "service.openai", {
    enabled: status.enabled,
    storeInDb: status.storeInDb,
    model: status.model
  });
  res.json({ ok: true, status });
}));

app.post("/api/admin/service/openai/test", requirePermission(Permissions.ADMIN_SECRET_MANAGE), adminLimiter, generationLimiter, withAsync(async (req, res) => {
  const body = requireObject(req.body || {}, "body");
  const applyRequested = Boolean(body.applyBeforeTest);
  const hasUpdatePayload = body.apiKey !== undefined || body.storeKey !== undefined || body.enabled !== undefined || body.model !== undefined;
  if (applyRequested || hasUpdatePayload) {
    await applyOpenAIServiceSettings({
      actor: req.actor,
      apiKey: body.apiKey === undefined ? undefined : String(body.apiKey || ""),
      storeKey: body.storeKey === undefined ? undefined : Boolean(body.storeKey),
      enabled: body.enabled === undefined ? undefined : Boolean(body.enabled),
      model: body.model ? String(body.model) : undefined
    });
  }
  try {
    const result = await runOpenAIConnectivityTest(req.actor, req.requestId || null);
    await persistOpenAITestStatus({ ok: true, code: "ok", errorMessage: null });
    await audit(req, "service.openai.test", "config", "service.openai", {
      source: result.source,
      model: result.model,
      requestId: result.requestId
    });
    res.json(result);
  } catch (err) {
    const classified = classifyOpenAITestError(err);
    await persistOpenAITestStatus({ ok: false, code: classified.code, errorMessage: classified.message });
    throw new AppError(classified.message, {
      status: err?.status && Number(err.status) >= 400 ? Number(err.status) : 400,
      code: "OPENAI_TEST_FAILED",
      expose: true,
      metadata: { requestId: req.requestId || null, reason: classified.code }
    });
  }
}));

app.post("/api/admin/reset", requirePermission(Permissions.ADMIN_RESET), adminLimiter, withAsync(async (req, res) => {
  const scope = asEnum(req.body?.scope || "all", ["all", "leaderboard", "results", "vocab"], "scope");
  await repo.reset(scope);
  await audit(req, "admin.reset", "scope", scope);
  res.json({ ok: true });
}));

app.get("/api/admin/service-settings", requirePermission(Permissions.ADMIN_CONFIG_MANAGE), adminLimiter, withAsync(async (req, res) => {
  const email = await smtpService.getEmailSettings();
  const providers = await configStore.get("auth.providers", {
    scope: "global",
    scopeId: "global",
    fallback: { google: { enabled: Boolean(BOOTSTRAP_GOOGLE_CLIENT_ID), clientId: BOOTSTRAP_GOOGLE_CLIENT_ID || "" } }
  });
  const googleSecret = await repo.getSystemSecret("google.client_secret");
  const openaiSummary = summarizeOpenAIServiceStatus(await getOpenAIServiceConfig());
  const openaiActive = await resolveOpenAIExecutionContext(req.actor, { includeLegacy: true });
  res.json({
    ok: true,
    settings: {
      email: {
        enabled: Boolean(email.enabled),
        host: email.host,
        port: email.port,
        secure: email.secure,
        username: email.username,
        fromAddress: email.fromAddress,
        fromName: email.fromName,
        hasPassword: Boolean(email.password)
      },
      auth: {
        google: {
          enabled: Boolean(providers?.google?.enabled),
          clientId: String(providers?.google?.clientId || ""),
          hasClientSecret: Boolean(googleSecret?.ciphertext)
        }
      },
      openai: {
        enabled: openaiSummary.enabled,
        configured: openaiSummary.configured || Boolean(openaiActive?.apiKey),
        storeInDb: openaiSummary.storeInDb,
        model: openaiSummary.model,
        lastTestAt: openaiSummary.lastTestAt || null,
        lastTestOk: Boolean(openaiSummary.lastTestOk),
        lastTestError: openaiSummary.lastTestError || null,
        source: openaiActive?.source || null
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
  const current = await smtpService.getEmailSettings();
  const merged = {
    enabled: Boolean(payload.enabled),
    host: String(payload.host || "").trim(),
    username: String(payload.username || "").trim(),
    fromAddress: String(payload.fromAddress || "").trim(),
    password: String(payload.password || current.password || "")
  };
  if (merged.enabled && (!merged.host || !merged.username || !merged.fromAddress || !merged.password)) {
    throw badRequest("SMTP cannot be enabled until host, username, from address, and password are configured");
  }
  await smtpService.saveEmailSettings(payload, req.actor?.externalSubject || "admin");
  await configStore.setSafe("service.email.status", {
    lastTestOk: false,
    lastError: "",
    lastTestAt: null
  }, { scope: "global", scopeId: "global", updatedBy: req.actor?.externalSubject || "admin" });
  const saved = await smtpService.getEmailSettings();
  await audit(req, "service_settings.email.update", "email", "smtp");
  await refreshConfigStatus({ force: true });
  res.json({ ok: true, settings: { ...saved, hasPassword: Boolean(saved.password) } });
}));

app.post("/api/admin/service-settings/email/test", requirePermission(Permissions.ADMIN_CONFIG_MANAGE), adminLimiter, withAsync(async (req, res) => {
  const to = asString(req.body?.to || req.actor?.email || "", { min: 5, max: 255, field: "to" });
  const payload = requireObject(req.body || {}, "email test");
  try {
    await smtpService.testSettings(payload.settings || {}, to);
    await configStore.setSafe("service.email.status", {
      lastTestOk: true,
      lastError: "",
      lastTestAt: new Date().toISOString()
    }, { scope: "global", scopeId: "global", updatedBy: req.actor?.externalSubject || "admin" });
    await audit(req, "service_settings.email.test", "email", to, { ok: true });
    await refreshConfigStatus({ force: true });
    return res.json({ ok: true });
  } catch (err) {
    await configStore.setSafe("service.email.status", {
      lastTestOk: false,
      lastError: String(err?.message || "SMTP test failed"),
      lastTestAt: new Date().toISOString()
    }, { scope: "global", scopeId: "global", updatedBy: req.actor?.externalSubject || "admin" });
    await audit(req, "service_settings.email.test", "email", to, { ok: false });
    await refreshConfigStatus({ force: true });
    throw err;
  }
}));

app.post("/api/admin/service-settings/auth/google", requirePermission(Permissions.ADMIN_CONFIG_MANAGE), adminLimiter, withAsync(async (req, res) => {
  const payload = requireObject(req.body || {}, "google auth settings");
  const enabled = Boolean(payload.enabled);
  const clientId = String(payload.clientId || "").trim();
  const existingSecret = await repo.getSystemSecret("google.client_secret");
  const hasIncomingSecret = Boolean(String(payload.clientSecret || "").trim());
  const hasStoredSecret = Boolean(existingSecret?.ciphertext && existingSecret?.iv && (existingSecret?.authTag || existingSecret?.authtag));
  if (enabled && (!clientId || (!hasIncomingSecret && !hasStoredSecret))) {
    throw badRequest("Google cannot be enabled until client ID and client secret are configured");
  }

  const providers = await configStore.get("auth.providers", {
    scope: "global",
    scopeId: "global",
    fallback: { google: { enabled: false, clientId: "" } }
  });
  await configStore.setSafe("auth.providers", {
    ...providers,
    google: {
      enabled,
      clientId
    }
  }, { scope: "global", scopeId: "global", updatedBy: req.actor?.externalSubject || "admin" });

  if (hasIncomingSecret) {
    const encrypted = encryptionService.encrypt(String(payload.clientSecret));
    await repo.setSystemSecret("google.client_secret", encrypted, req.actor?.externalSubject || "admin");
  }

  await audit(req, "service_settings.google.update", "auth", "google", { enabled, hasClientId: Boolean(clientId), hasClientSecret: Boolean(payload.clientSecret) });
  await refreshConfigStatus({ force: true });
  res.json({ ok: true, settings: { enabled, clientId, hasClientSecret: Boolean(await repo.getSystemSecret("google.client_secret")) } });
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

app.get("/api/admin/config/status", requirePermission(Permissions.ADMIN_CONFIG_MANAGE), adminLimiter, withAsync(async (req, res) => {
  const status = await refreshConfigStatus({ force: true });
  res.json({ ok: true, status });
}));

app.post("/api/admin/config/test/smtp", requirePermission(Permissions.ADMIN_CONFIG_MANAGE), adminLimiter, withAsync(async (req, res) => {
  const payload = requireObject(req.body || {}, "smtp test");
  const to = asString(payload.to || req.actor?.email || "", { min: 5, max: 255, field: "to" });
  try {
    await smtpService.testSettings(payload.settings || {}, to);
    await configStore.setSafe("service.email.status", {
      lastTestOk: true,
      lastError: "",
      lastTestAt: new Date().toISOString()
    }, { scope: "global", scopeId: "global", updatedBy: req.actor?.externalSubject || "admin" });
    await audit(req, "config.test.smtp", "smtp", to, { ok: true });
    await refreshConfigStatus({ force: true });
    res.json({ ok: true, result: { status: "READY" } });
  } catch (err) {
    await configStore.setSafe("service.email.status", {
      lastTestOk: false,
      lastError: String(err?.message || "SMTP test failed"),
      lastTestAt: new Date().toISOString()
    }, { scope: "global", scopeId: "global", updatedBy: req.actor?.externalSubject || "admin" });
    await audit(req, "config.test.smtp", "smtp", to, { ok: false });
    await refreshConfigStatus({ force: true });
    res.status(400).json({ ok: false, result: { status: "INVALID", message: String(err?.message || "SMTP test failed") } });
  }
}));

app.post("/api/admin/config/test/db", requirePermission(Permissions.ADMIN_DB_TEST), adminLimiter, withAsync(async (req, res) => {
  try {
    await repo.ping();
    const migration = await getMigrationStatus(repo, activeDriver);
    const ok = Array.isArray(migration?.pending) ? migration.pending.length === 0 : true;
    res.json({ ok: true, result: { status: ok ? "READY" : "INVALID", migration } });
  } catch (err) {
    res.status(400).json({ ok: false, result: { status: "INVALID", message: String(err?.message || "DB test failed") } });
  }
}));

app.post("/api/admin/config/test/google", requirePermission(Permissions.ADMIN_CONFIG_MANAGE), adminLimiter, withAsync(async (req, res) => {
  const provider = await configStore.get("auth.providers", {
    scope: "global",
    scopeId: "global",
    fallback: { google: { enabled: false, clientId: "" } }
  });
  const enabled = Boolean(provider?.google?.enabled);
  const clientId = String(provider?.google?.clientId || "");
  const secret = await repo.getSystemSecret("google.client_secret");
  const ok = !enabled || (clientId && secret?.ciphertext);
  res.json({
    ok,
    result: {
      status: ok ? "READY" : "INVALID",
      enabled,
      hasClientId: Boolean(clientId),
      hasClientSecret: Boolean(secret?.ciphertext)
    }
  });
}));

app.post("/api/admin/config/apply", requirePermission(Permissions.ADMIN_CONFIG_MANAGE), adminLimiter, withAsync(async (req, res) => {
  const payload = requireObject(req.body || {}, "config apply");
  const changes = Array.isArray(payload.changes) ? payload.changes : [];
  const allowPartialSetup = Boolean(payload.allowPartialSetup);
  if (changes.length === 0) throw badRequest("No config changes provided");

  const snapshot = await configStore.exportSafeConfig();
  const updates = [];
  for (const row of changes) {
    const key = asString(row?.key || "", { min: 1, max: 128, field: "key" });
    const scope = asEnum(row?.scope || "global", ["global", "tenant", "user"], "scope");
    const scopeId = asString(row?.scopeId || "global", { min: 1, max: 128, field: "scopeId" });
    const valueJson = row?.valueJson;
    const updated = await configStore.setSafe(key, valueJson, {
      scope,
      scopeId,
      updatedBy: req.actor?.externalSubject || "admin"
    });
    updates.push(updated);
  }

  const status = await refreshConfigStatus({ force: true });
  if (!allowPartialSetup && status?.overall === "SETUP_REQUIRED") {
    // WHY: reject and rollback by default so an admin cannot accidentally persist
    // blocking required-config regressions outside explicit setup workflows.
    await configStore.importSafeConfig(snapshot, req.actor?.externalSubject || "admin:rollback");
    await refreshConfigStatus({ force: true });
    throw new AppError("Apply rejected: required configuration became invalid", {
      status: 409,
      code: "CONFIG_REQUIRED_INVALID",
      expose: true
    });
  }
  await audit(req, "config.apply", "config", "global", { keys: updates.map((row) => row.key) });
  res.json({ ok: true, status, appliedKeys: updates.map((row) => row.key) });
}));

app.get("/api/admin/config/export", requirePermission(Permissions.ADMIN_CONFIG_PORTABILITY), adminLimiter, withAsync(async (req, res) => {
  const rows = await configStore.exportSafeConfig();
  res.json({ ok: true, rows });
}));

app.post("/api/admin/config/import", requirePermission(Permissions.ADMIN_CONFIG_PORTABILITY), adminLimiter, withAsync(async (req, res) => {
  const rows = req.body?.rows;
  await configStore.importSafeConfig(rows, req.actor?.externalSubject || "admin");
  await audit(req, "config.import", "config", "global", { count: Array.isArray(rows) ? rows.length : 0 });
  await refreshConfigStatus({ force: true });
  res.json({ ok: true });
}));

app.post("/api/admin/config/export", requirePermission(Permissions.ADMIN_CONFIG_PORTABILITY), adminLimiter, withAsync(async (req, res) => {
  const includeSecrets = Boolean(req.body?.includeSecrets);
  const rows = await configStore.exportSafeConfig();
  const authProviders = await configStore.get("auth.providers", {
    scope: "global",
    scopeId: "global",
    fallback: { google: { enabled: Boolean(BOOTSTRAP_GOOGLE_CLIENT_ID), clientId: BOOTSTRAP_GOOGLE_CLIENT_ID || "" } }
  });
  const emailSettings = await smtpService.getEmailSettings();
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
    authProviderMeta: { googleEnabled: Boolean(authProviders?.google?.enabled), passwordEnabled: true },
    smtpMeta: {
      configured: Boolean(emailSettings.enabled && emailSettings.host)
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
  await refreshConfigStatus({ force: true });
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
  if (!keys.has("app.config_version")) {
    await configStore.setSafe("app.config_version", { version: 1, updatedAt: new Date().toISOString() }, { scope: "global", scopeId: "global", updatedBy: "bootstrap" });
  }
  if (!keys.has("app.features")) {
    await configStore.setSafe("app.features", { maintenanceMode: false }, { scope: "global", scopeId: "global", updatedBy: "bootstrap" });
  }
  if (!keys.has("contest.rules")) {
    await configStore.setSafe("contest.rules", { maxAllowedLevel: 5, durations: [30, 60, 120], taskTargets: [10, 20, 50] }, { scope: "global", scopeId: "global", updatedBy: "bootstrap" });
  }
  if (!keys.has("generator.defaults")) {
    await configStore.setSafe("generator.defaults", { openAiModel: OPENAI_MODEL, maxCount: 200, openaiEnabled: false }, { scope: "global", scopeId: "global", updatedBy: "bootstrap" });
  }
  if (!keys.has("service.openai")) {
    await configStore.setSafe("service.openai", {
      enabled: false,
      storeInDb: true,
      model: OPENAI_MODEL,
      apiKeyEnc: null,
      lastTestAt: null,
      lastTestOk: false,
      lastTestError: null,
      lastTestCode: null
    }, { scope: "global", scopeId: "global", updatedBy: "bootstrap" });
  }
  if (!keys.has("service.email")) {
    await configStore.setSafe("service.email", {
      enabled: false,
      host: "",
      port: 587,
      secure: false,
      username: "",
      fromAddress: "",
      fromName: "KTrain"
    }, { scope: "global", scopeId: "global", updatedBy: "bootstrap" });
  }
  if (!keys.has("service.email.status")) {
    await configStore.setSafe("service.email.status", {
      lastTestOk: false,
      lastError: "",
      lastTestAt: null
    }, { scope: "global", scopeId: "global", updatedBy: "bootstrap" });
  }
  if (!keys.has("auth.providers")) {
    await configStore.setSafe("auth.providers", {
      google: {
        enabled: Boolean(BOOTSTRAP_GOOGLE_CLIENT_ID),
        clientId: BOOTSTRAP_GOOGLE_CLIENT_ID || ""
      }
    }, { scope: "global", scopeId: "global", updatedBy: "bootstrap" });
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
  // SECURITY: encryption master key is mandatory; fail-fast avoids undefined
  // behavior when reading/writing encrypted secrets.
  if (!process.env.KTRAIN_MASTER_KEY) {
    throw new Error("KTRAIN_MASTER_KEY is required");
  }
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

  setStartupPhase("compute_config_status");
  const status = await refreshConfigStatus({ force: true });
  logger.info("config_status", { overall: status?.overall, required: status?.required, optional: status?.optional });

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
