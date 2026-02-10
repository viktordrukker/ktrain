const { Roles, normalizeRole } = require("../domain/rbac");

/**
 * Central configuration health evaluator.
 *
 * Output contract:
 * - Required checks decide `SETUP_REQUIRED`.
 * - Optional checks decide `DEGRADED`.
 * - Maintenance is reserved for migration/runtime safety gates.
 *
 * This module is the single source of truth for setup/degraded readiness.
 */
function statusDetail({
  key,
  severity,
  message,
  remediationHint,
  affectedFeatures = [],
  blocking = false
}) {
  return {
    key,
    severity,
    message,
    remediation_hint: remediationHint,
    affected_features: affectedFeatures,
    blocking
  };
}

function mapStepState(ok, missing = "MISSING") {
  return ok ? "READY" : missing;
}

function normalizeEmailSettings(email) {
  return {
    enabled: Boolean(email?.enabled),
    host: String(email?.host || "").trim(),
    port: Number(email?.port || 587),
    secure: Boolean(email?.secure),
    username: String(email?.username || "").trim(),
    fromAddress: String(email?.fromAddress || "").trim()
  };
}

function hasGoogleSecret(secret) {
  return Boolean(secret?.ciphertext && secret?.iv && (secret?.authTag || secret?.authtag));
}

async function hasAdminPasswordIdentity(repo) {
  const users = await repo.listUsers();
  for (const user of users) {
    const role = normalizeRole(user.role);
    if (![Roles.OWNER, Roles.ADMIN].includes(role)) continue;
    if (!user.email) continue;
    const identity = await repo.findPasswordIdentityByEmail(user.email);
    const hash = identity?.passwordHash || identity?.passwordhash || "";
    if (hash && String(hash).trim().length >= 20) return true;
  }
  return false;
}

/**
 * Compute runtime configuration health from DB-backed config plus live dependency checks.
 *
 * SECURITY: the returned object must be safe to expose (no secrets, only status metadata).
 */
async function computeConfigStatus({
  repo,
  configStore,
  smtpService,
  activeDriver,
  maintenanceMode,
  migrationStatus,
  googleClientIdFromEnv = "",
  openaiModel = "gpt-4o-mini"
}) {
  const details = [];
  const required = {
    database: "MISSING",
    adminUser: "MISSING"
  };
  const optional = {
    smtp: "MISSING",
    googleAuth: "MISSING",
    openai: "MISSING",
    languagePacks: "MISSING"
  };

  let dbOk = false;
  let migration = null;
  try {
    await repo.ping();
    dbOk = true;
    migration = await migrationStatus(repo, activeDriver);
    required.database = (Array.isArray(migration?.pending) && migration.pending.length === 0) ? "READY" : "INVALID";
  } catch (err) {
    required.database = "INVALID";
    details.push(statusDetail({
      key: "database",
      severity: "ERROR",
      message: "Database is unreachable or failed basic checks.",
      remediationHint: "Check active driver connection and rerun migrations.",
      affectedFeatures: ["all"],
      blocking: true
    }));
  }

  if (required.database !== "READY") {
    details.push(statusDetail({
      key: "database.migrations",
      severity: "ERROR",
      message: "Required DB migrations are pending or failed.",
      remediationHint: "Run migration command and verify schema compatibility.",
      affectedFeatures: ["all"],
      blocking: true
    }));
  }

  const hasAdminCred = dbOk ? await hasAdminPasswordIdentity(repo) : false;
  required.adminUser = mapStepState(hasAdminCred);
  if (!hasAdminCred) {
    details.push(statusDetail({
      key: "adminUser",
      severity: "ERROR",
      message: "No admin account with password credentials exists.",
      remediationHint: "Create an OWNER/ADMIN account in setup.",
      affectedFeatures: ["admin-panel", "service-controls"],
      blocking: true
    }));
  }

  const email = normalizeEmailSettings(await smtpService.getEmailSettings());
  const smtpStatus = await configStore.get("service.email.status", {
    scope: "global",
    scopeId: "global",
    fallback: { lastTestOk: false, lastError: "", lastTestAt: null }
  });
  if (!email.enabled) {
    optional.smtp = "MISSING";
  } else if (email.host && email.username && email.fromAddress && smtpStatus?.lastTestOk) {
    optional.smtp = "READY";
  } else {
    optional.smtp = "INVALID";
    details.push(statusDetail({
      key: "smtp",
      severity: "WARN",
      message: "SMTP is enabled but invalid or untested.",
      remediationHint: "Update SMTP settings and run test email.",
      affectedFeatures: ["password-reset", "notifications"],
      blocking: false
    }));
  }

  const authProviders = await configStore.get("auth.providers", {
    scope: "global",
    scopeId: "global",
    fallback: {
      google: {
        enabled: Boolean(googleClientIdFromEnv),
        clientId: googleClientIdFromEnv || ""
      }
    }
  });
  const googleEnabled = Boolean(authProviders?.google?.enabled);
  const googleClientId = String(authProviders?.google?.clientId || googleClientIdFromEnv || "").trim();
  const googleSecret = await repo.getSystemSecret("google.client_secret");
  if (!googleEnabled) {
    optional.googleAuth = "MISSING";
  } else if (googleClientId && hasGoogleSecret(googleSecret)) {
    optional.googleAuth = "READY";
  } else {
    optional.googleAuth = "INVALID";
    details.push(statusDetail({
      key: "googleAuth",
      severity: "WARN",
      message: "Google auth is enabled but client configuration is incomplete.",
      remediationHint: "Set Google client ID and client secret in Admin settings.",
      affectedFeatures: ["google-login"],
      blocking: false
    }));
  }

  const generatorDefaults = await configStore.get("generator.defaults", {
    scope: "global",
    scopeId: "global",
    fallback: { openAiModel: openaiModel, maxCount: 200, openaiEnabled: false }
  });
  const openaiEnabled = Boolean(generatorDefaults?.openaiEnabled);
  const openaiSystemKey = await repo.getSetting("openai_key");
  if (!openaiEnabled) {
    optional.openai = "MISSING";
  } else if (openaiSystemKey) {
    optional.openai = "READY";
  } else {
    optional.openai = "INVALID";
    details.push(statusDetail({
      key: "openai",
      severity: "WARN",
      message: "OpenAI generation is enabled but no system key is configured.",
      remediationHint: "Disable generation or configure an OpenAI key.",
      affectedFeatures: ["pack-generation"],
      blocking: false
    }));
  }

  const publishedPacks = await repo.listLanguagePacks({ status: "PUBLISHED" });
  const hasEn = publishedPacks.some((pack) => String(pack.language || "").toLowerCase() === "en");
  const hasRu = publishedPacks.some((pack) => String(pack.language || "").toLowerCase() === "ru");
  if (hasEn) {
    optional.languagePacks = "READY";
  } else {
    optional.languagePacks = "INVALID";
    details.push(statusDetail({
      key: "languagePacks.en",
      severity: "WARN",
      message: "Published English packs are missing.",
      remediationHint: "Seed built-in EN packs from Admin -> Content.",
      affectedFeatures: ["game-content"],
      blocking: false
    }));
  }
  if (!hasRu) {
    details.push(statusDetail({
      key: "languagePacks.ru",
      severity: "INFO",
      message: "Published Russian packs are missing.",
      remediationHint: "Seed or generate RU packs to enable Russian gameplay.",
      affectedFeatures: ["ru-language-content"],
      blocking: false
    }));
  }

  const requiredNotReady = Object.values(required).some((s) => s !== "READY");
  const optionalInvalidEnabled =
    (optional.smtp === "INVALID" && email.enabled) ||
    (optional.googleAuth === "INVALID" && googleEnabled) ||
    (optional.openai === "INVALID" && openaiEnabled) ||
    (optional.languagePacks === "INVALID");

  let overall = "READY";
  if (maintenanceMode || (required.database === "INVALID" && Array.isArray(migration?.pending) && migration.pending.length > 0)) {
    overall = "MAINTENANCE";
  } else if (requiredNotReady) {
    overall = "SETUP_REQUIRED";
  } else if (optionalInvalidEnabled) {
    overall = "DEGRADED";
  }

  const configVersion = await configStore.getVersion();
  return {
    overall,
    required,
    optional,
    details,
    computed_at: new Date().toISOString(),
    config_version: configVersion
  };
}

module.exports = {
  computeConfigStatus
};
