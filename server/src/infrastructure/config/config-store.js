const { badRequest } = require("../../shared/errors");

const SAFE_CONFIG_KEYS = new Set([
  "app.settings",
  "app.features",
  "contest.rules",
  "generator.defaults",
  "theme.defaults",
  "service.email"
]);

const VALID_SCOPES = new Set(["global", "tenant", "user"]);

class ConfigStore {
  constructor({ repo, ttlMs = 5000 }) {
    this.repo = repo;
    this.ttlMs = ttlMs;
    this.cache = new Map();
  }

  makeKey(key, scope, scopeId) {
    return `${scope}:${scopeId || "*"}:${key}`;
  }

  assertSafeKey(key) {
    if (!SAFE_CONFIG_KEYS.has(key)) {
      throw badRequest("Unsupported config key");
    }
  }

  assertScope(scope) {
    if (!VALID_SCOPES.has(scope)) {
      throw badRequest("Invalid config scope");
    }
  }

  async get(key, { scope = "global", scopeId = "global", fallback = null } = {}) {
    this.assertScope(scope);
    const cacheKey = this.makeKey(key, scope, scopeId);
    const now = Date.now();
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > now) return cached.value;
    const row = await this.repo.getConfig(key, scope, scopeId);
    const value = row ? row.valueJson : fallback;
    this.cache.set(cacheKey, { value, expiresAt: now + this.ttlMs });
    return value;
  }

  async setSafe(key, value, { scope = "global", scopeId = "global", updatedBy = "system" } = {}) {
    this.assertSafeKey(key);
    this.assertScope(scope);
    await this.repo.setConfig(key, scope, scopeId, value, updatedBy);
    this.invalidate(key, scope, scopeId);
    return { key, scope, scopeId, value };
  }

  async list({ scope = "global", scopeId = "global" } = {}) {
    this.assertScope(scope);
    return this.repo.listConfig(scope, scopeId);
  }

  async exportSafeConfig() {
    const rows = await this.repo.listConfig("global", "global");
    return rows.filter((row) => SAFE_CONFIG_KEYS.has(row.key));
  }

  async importSafeConfig(rows = [], updatedBy = "system") {
    if (!Array.isArray(rows)) throw badRequest("Invalid config payload");
    for (const row of rows) {
      this.assertSafeKey(row.key);
      this.assertScope(row.scope || "global");
      // WHY: import only explicitly allowed keys to prevent arbitrary server behavior changes.
      await this.repo.setConfig(row.key, row.scope || "global", row.scopeId || "global", row.valueJson, updatedBy);
      this.invalidate(row.key, row.scope || "global", row.scopeId || "global");
    }
  }

  invalidate(key, scope, scopeId) {
    this.cache.delete(this.makeKey(key, scope, scopeId));
  }
}

module.exports = {
  ConfigStore,
  SAFE_CONFIG_KEYS,
  VALID_SCOPES
};
