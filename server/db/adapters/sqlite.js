const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

function ensureDir(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function nowIso() {
  return new Date().toISOString();
}

function mapUserRow(row) {
  if (!row) return null;
  return {
    ...row,
    avatarUrl: row.avatarurl || row.avatarUrl || null
  };
}

class SqliteAdapter {
  constructor({ sqlitePath, migrationSql }) {
    this.driver = "sqlite";
    this.sqlitePath = sqlitePath;
    this.migrationSql = migrationSql;
    this.db = null;
  }

  async init() {
    ensureDir(this.sqlitePath);
    this.db = new Database(this.sqlitePath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("synchronous = NORMAL");
    if (this.migrationSql) {
      this.db.exec(this.migrationSql);
    }
  }

  async close() {
    if (this.db) this.db.close();
  }

  async ping() {
    this.db.prepare("SELECT 1").get();
    return true;
  }

  async runMigrations(migrations) {
    this.db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, appliedAt TEXT NOT NULL)");
    const applied = new Set(this.db.prepare("SELECT id FROM schema_migrations").all().map((row) => row.id));
    const tx = this.db.transaction(() => {
      for (const migration of migrations) {
        if (applied.has(migration.id)) continue;
        this.db.exec(migration.sql);
        this.db.prepare("INSERT INTO schema_migrations (id, appliedAt) VALUES (?, ?)").run(migration.id, nowIso());
      }
    });
    tx();
    return this.db.prepare("SELECT id, appliedAt FROM schema_migrations ORDER BY id ASC").all();
  }

  async getAppliedMigrations() {
    this.db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, appliedAt TEXT NOT NULL)");
    return this.db.prepare("SELECT id, appliedAt FROM schema_migrations ORDER BY id ASC").all();
  }

  async rollbackMigration(id, downSql) {
    const tx = this.db.transaction(() => {
      this.db.exec(downSql);
      this.db.prepare("DELETE FROM schema_migrations WHERE id = ?").run(id);
    });
    tx();
  }

  async hasIndex(indexName) {
    const row = this.db
      .prepare("SELECT 1 as ok FROM sqlite_master WHERE type = 'index' AND name = ?")
      .get(indexName);
    return Boolean(row?.ok);
  }

  async getSetting(key) {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
    return row ? row.value : null;
  }

  async setSetting(key, value) {
    this.db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }

  async insertLeaderboard(payload) {
    this.db.prepare(`
      INSERT INTO leaderboard
      (playerName, createdAt, contestType, level, contentMode, duration, taskTarget, score, accuracy, cpm, mistakes, tasksCompleted, timeSeconds, maxStreak, userId, isGuest, language, displayName, avatarUrl)
      VALUES
      (@playerName, @createdAt, @contestType, @level, @contentMode, @duration, @taskTarget, @score, @accuracy, @cpm, @mistakes, @tasksCompleted, @timeSeconds, @maxStreak, @userId, @isGuest, @language, @displayName, @avatarUrl)
    `).run(payload);
  }

  async queryLeaderboard(filters) {
    const params = [];
    let where = "WHERE 1=1";
    if (filters.contestType) { where += " AND contestType = ?"; params.push(filters.contestType); }
    if (filters.level) { where += " AND level = ?"; params.push(Number(filters.level)); }
    if (filters.contentMode) { where += " AND contentMode = ?"; params.push(filters.contentMode); }
    if (filters.duration && filters.contestType === "time") { where += " AND duration = ?"; params.push(Number(filters.duration)); }
    if (filters.taskTarget && filters.contestType === "tasks") { where += " AND taskTarget = ?"; params.push(Number(filters.taskTarget)); }
    if (filters.onlyAuthorized) { where += " AND isGuest = 0"; }
    if (filters.language) { where += " AND language = ?"; params.push(filters.language); }
    return this.db.prepare(`SELECT * FROM leaderboard ${where} ORDER BY score DESC, accuracy DESC LIMIT 20`).all(...params);
  }

  async queryLeaderboardPage(filters = {}, options = {}) {
    const params = [];
    let where = "WHERE 1=1";
    if (filters.contestType) { where += " AND contestType = ?"; params.push(filters.contestType); }
    if (filters.level) { where += " AND level = ?"; params.push(Number(filters.level)); }
    if (filters.contentMode) { where += " AND contentMode = ?"; params.push(filters.contentMode); }
    if (filters.duration && filters.contestType === "time") { where += " AND duration = ?"; params.push(Number(filters.duration)); }
    if (filters.taskTarget && filters.contestType === "tasks") { where += " AND taskTarget = ?"; params.push(Number(filters.taskTarget)); }
    if (filters.onlyAuthorized) { where += " AND isGuest = 0"; }
    if (filters.language) { where += " AND language = ?"; params.push(filters.language); }
    if (filters.createdAfter) { where += " AND createdAt >= ?"; params.push(filters.createdAfter); }

    const sortable = {
      score: "score",
      accuracy: "accuracy",
      cpm: "cpm",
      date: "createdAt",
      createdAt: "createdAt"
    };
    const sortBy = sortable[options.sortBy] || "score";
    const sortDir = String(options.sortDir || "desc").toLowerCase() === "asc" ? "ASC" : "DESC";
    const page = Math.max(1, Number(options.page || 1));
    const pageSize = Math.max(5, Math.min(100, Number(options.pageSize || 20)));
    const offset = (page - 1) * pageSize;

    const totalRow = this.db.prepare(`SELECT COUNT(*) as c FROM leaderboard ${where}`).get(...params);
    const total = Number(totalRow?.c || 0);
    const rows = this.db
      .prepare(`SELECT * FROM leaderboard ${where} ORDER BY ${sortBy} ${sortDir}, id ASC LIMIT ? OFFSET ?`)
      .all(...params, pageSize, offset);
    return { rows, total, page, pageSize };
  }
  async getGamePreferences(userId) {
    return this.db.prepare("SELECT * FROM game_preferences WHERE userId = ? LIMIT 1").get(userId) || null;
  }

  async upsertGamePreferences({ userId, mode, level, contentType, language, updatedAt }) {
    this.db.prepare(`
      INSERT INTO game_preferences (userId, mode, level, contentType, language, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(userId) DO UPDATE SET
        mode = excluded.mode,
        level = excluded.level,
        contentType = excluded.contentType,
        language = excluded.language,
        updatedAt = excluded.updatedAt
    `).run(userId, mode, level, contentType, language, updatedAt);
  }

  async getPlayerStats(userId) {
    return this.db.prepare("SELECT * FROM player_stats WHERE userId = ? LIMIT 1").get(userId) || null;
  }

  async upsertPlayerStats({
    userId,
    totalLettersTyped,
    totalCorrect,
    totalIncorrect,
    bestWPM,
    sessionsCount,
    totalPlayTimeMs,
    streakDays,
    lastSessionAt
  }) {
    this.db.prepare(`
      INSERT INTO player_stats
      (userId, totalLettersTyped, totalCorrect, totalIncorrect, bestWPM, sessionsCount, totalPlayTimeMs, streakDays, lastSessionAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(userId) DO UPDATE SET
        totalLettersTyped = excluded.totalLettersTyped,
        totalCorrect = excluded.totalCorrect,
        totalIncorrect = excluded.totalIncorrect,
        bestWPM = excluded.bestWPM,
        sessionsCount = excluded.sessionsCount,
        totalPlayTimeMs = excluded.totalPlayTimeMs,
        streakDays = excluded.streakDays,
        lastSessionAt = excluded.lastSessionAt
    `).run(userId, totalLettersTyped, totalCorrect, totalIncorrect, bestWPM, sessionsCount, totalPlayTimeMs, streakDays, lastSessionAt || null);
  }

  async listPacks() {
    return this.db.prepare("SELECT * FROM vocab_packs ORDER BY createdAt DESC").all();
  }

  async getPackById(id) {
    return this.db.prepare("SELECT * FROM vocab_packs WHERE id = ?").get(id);
  }

  async getActivePack(packType) {
    return this.db.prepare("SELECT * FROM vocab_packs WHERE packType = ? AND active = 1 ORDER BY id DESC LIMIT 1").get(packType);
  }

  async activatePack(id, packType) {
    const tx = this.db.transaction(() => {
      this.db.prepare("UPDATE vocab_packs SET active = 0 WHERE packType = ?").run(packType);
      this.db.prepare("UPDATE vocab_packs SET active = 1 WHERE id = ?").run(id);
    });
    tx();
  }

  async updatePack(id, name, itemsJson) {
    this.db.prepare("UPDATE vocab_packs SET name = COALESCE(?, name), items = ? WHERE id = ?").run(name || null, itemsJson, id);
  }

  async deletePack(id) {
    this.db.prepare("DELETE FROM vocab_packs WHERE id = ?").run(id);
  }

  async insertPack({ name, packType, itemsJson, active, createdAt }) {
    this.db.prepare("INSERT INTO vocab_packs (name, packType, items, active, createdAt) VALUES (?, ?, ?, ?, ?)").run(name, packType, itemsJson, active ? 1 : 0, createdAt);
  }

  async findUserByExternalSubject(externalSubject) {
    const row = this.db.prepare("SELECT * FROM users WHERE externalSubject = ? LIMIT 1").get(externalSubject);
    return mapUserRow(row);
  }

  async findUserByEmail(email) {
    const row = this.db.prepare("SELECT * FROM users WHERE lower(email) = lower(?) LIMIT 1").get(email);
    return mapUserRow(row);
  }

  async findUserByDisplayName(displayName) {
    const row = this.db
      .prepare("SELECT * FROM users WHERE lower(trim(displayName)) = lower(trim(?)) LIMIT 1")
      .get(displayName);
    return mapUserRow(row);
  }

  async findUserById(id) {
    const row = this.db.prepare("SELECT * FROM users WHERE id = ? LIMIT 1").get(id);
    return mapUserRow(row);
  }

  async getOwnerUser() {
    return mapUserRow(this.db.prepare("SELECT * FROM users WHERE role = 'OWNER' ORDER BY id ASC LIMIT 1").get());
  }

  async createUser({ externalSubject, email, displayName, role, avatarUrl }) {
    const now = nowIso();
    const result = this.db
      .prepare(
        "INSERT INTO users (externalSubject, email, displayName, avatarUrl, role, isActive, createdAt, updatedAt, lastLoginAt) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)"
      )
      .run(externalSubject, email || null, displayName || null, avatarUrl || null, role, now, now, now);
    return this.db.prepare("SELECT * FROM users WHERE id = ?").get(result.lastInsertRowid);
  }

  async listUsers() {
    return this.db.prepare("SELECT id, externalSubject, email, displayName, avatarUrl, role, isActive, createdAt, updatedAt, lastLoginAt FROM users ORDER BY id ASC").all();
  }

  async updateUserRole(id, role) {
    this.db.prepare("UPDATE users SET role = ?, updatedAt = ? WHERE id = ?").run(role, nowIso(), id);
    return this.db.prepare("SELECT * FROM users WHERE id = ?").get(id) || null;
  }

  async touchUserLogin(id) {
    this.db.prepare("UPDATE users SET lastLoginAt = ?, updatedAt = ? WHERE id = ?").run(nowIso(), nowIso(), id);
  }

  async updateUserProfile(id, { displayName, avatarUrl }) {
    this.db.prepare("UPDATE users SET displayName = COALESCE(?, displayName), avatarUrl = COALESCE(?, avatarUrl), updatedAt = ? WHERE id = ?").run(displayName || null, avatarUrl || null, nowIso(), id);
    if (avatarUrl !== undefined) {
      await this.setConfig("user.avatar", "user", String(id), { avatarUrl: avatarUrl || "" }, `user:${id}`);
    }
    return this.findUserById(id);
  }

  async findAuthIdentity({ provider, providerSubject }) {
    const row = this.db.prepare("SELECT * FROM auth_identities WHERE provider = ? AND providerSubject = ? LIMIT 1").get(provider, providerSubject);
    return row || null;
  }

  async findPasswordIdentityByEmail(email) {
    const row = this.db.prepare(`
      SELECT ai.*, u.email, u.displayName, u.avatarUrl, u.role, u.isActive, u.id as userId
      FROM auth_identities ai
      JOIN users u ON u.id = ai.userId
      WHERE ai.provider = 'password' AND lower(u.email) = lower(?)
      LIMIT 1
    `).get(email);
    return row || null;
  }

  async upsertAuthIdentity({ userId, provider, providerSubject, passwordHash }) {
    const now = nowIso();
    this.db.prepare(`
      INSERT INTO auth_identities (userId, provider, providerSubject, passwordHash, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(userId, provider) DO UPDATE SET
      providerSubject = excluded.providerSubject,
      passwordHash = COALESCE(excluded.passwordHash, auth_identities.passwordHash),
      updatedAt = excluded.updatedAt
    `).run(userId, provider, providerSubject || null, passwordHash || null, now, now);
  }

  async createPasswordReset({ userId, tokenHash, expiresAt, requestedIp }) {
    this.db.prepare(`
      INSERT INTO password_resets (userId, tokenHash, expiresAt, usedAt, createdAt, requestedIp)
      VALUES (?, ?, ?, NULL, ?, ?)
    `).run(userId, tokenHash, expiresAt, nowIso(), requestedIp || null);
  }

  async consumePasswordReset(tokenHash) {
    const row = this.db.prepare("SELECT * FROM password_resets WHERE tokenHash = ? LIMIT 1").get(tokenHash);
    if (!row || row.usedAt) return null;
    if (Date.parse(row.expiresAt) < Date.now()) return null;
    this.db.prepare("UPDATE password_resets SET usedAt = ? WHERE id = ?").run(nowIso(), row.id);
    return row;
  }

  async getUserSecret(userId, secretKey) {
    return this.db
      .prepare("SELECT * FROM user_secrets WHERE userId = ? AND secretKey = ? LIMIT 1")
      .get(userId, secretKey) || null;
  }

  async upsertUserSecret(userId, secretKey, encrypted) {
    const now = nowIso();
    this.db.prepare(`
      INSERT INTO user_secrets (userId, secretKey, ciphertext, iv, authTag, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(userId, secretKey) DO UPDATE SET
      ciphertext = excluded.ciphertext,
      iv = excluded.iv,
      authTag = excluded.authTag,
      updatedAt = excluded.updatedAt
    `).run(userId, secretKey, encrypted.ciphertext, encrypted.iv, encrypted.authTag, now, now);
  }

  async setSystemSecret(secretKey, encrypted, updatedBy) {
    this.db.prepare(`
      INSERT INTO system_secrets (secretKey, ciphertext, iv, authTag, updatedAt, updatedBy)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(secretKey) DO UPDATE SET
      ciphertext = excluded.ciphertext,
      iv = excluded.iv,
      authTag = excluded.authTag,
      updatedAt = excluded.updatedAt,
      updatedBy = excluded.updatedBy
    `).run(secretKey, encrypted.ciphertext, encrypted.iv, encrypted.authTag, nowIso(), updatedBy || null);
  }

  async getSystemSecret(secretKey) {
    return this.db.prepare("SELECT * FROM system_secrets WHERE secretKey = ? LIMIT 1").get(secretKey) || null;
  }

  async setConfig(key, scope, scopeId, valueJson, updatedBy) {
    this.db.prepare(`
      INSERT INTO app_config (key, scope, scopeId, valueJson, updatedAt, updatedBy)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(key, scope, scopeId) DO UPDATE SET
      valueJson = excluded.valueJson,
      updatedAt = excluded.updatedAt,
      updatedBy = excluded.updatedBy
    `).run(key, scope, scopeId, JSON.stringify(valueJson), nowIso(), updatedBy || null);
  }

  async getConfig(key, scope, scopeId) {
    const row = this.db
      .prepare("SELECT * FROM app_config WHERE key = ? AND scope = ? AND scopeId = ? LIMIT 1")
      .get(key, scope, scopeId);
    if (!row) return null;
    return {
      ...row,
      valueJson: JSON.parse(row.valueJson)
    };
  }

  async listConfig(scope, scopeId) {
    return this.db
      .prepare("SELECT * FROM app_config WHERE scope = ? AND scopeId = ? ORDER BY key ASC")
      .all(scope, scopeId)
      .map((row) => ({ ...row, valueJson: JSON.parse(row.valueJson) }));
  }

  async insertAuditLog(payload) {
    this.db.prepare(`
      INSERT INTO audit_log (actorUserId, actorRole, action, targetType, targetId, metadata, requestId, ip, createdAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      payload.actorUserId || null,
      payload.actorRole || null,
      payload.action,
      payload.targetType || null,
      payload.targetId || null,
      payload.metadata ? JSON.stringify(payload.metadata) : null,
      payload.requestId || null,
      payload.ip || null,
      payload.createdAt || nowIso()
    );
  }

  async listAuditLogs(limit = 100) {
    return this.db
      .prepare("SELECT * FROM audit_log ORDER BY id DESC LIMIT ?")
      .all(Number(limit))
      .map((row) => ({ ...row, metadata: row.metadata ? JSON.parse(row.metadata) : null }));
  }

  async insertCrashEvent(payload) {
    this.db.prepare(`
      INSERT INTO crash_events
      (occurredAt, appVersion, appBuild, appCommit, appMode, crashType, startupPhase, errorName, errorMessage, stackTrace, hostname, uptimeSeconds, metadataJson, acknowledgedAt, acknowledgedBy, resolved)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      payload.occurredAt,
      payload.appVersion || null,
      payload.appBuild || null,
      payload.appCommit || null,
      payload.appMode || null,
      payload.crashType,
      payload.startupPhase || null,
      payload.errorName || null,
      payload.errorMessage || null,
      payload.stackTrace || null,
      payload.hostname || null,
      payload.uptimeSeconds || null,
      payload.metadataJson ? JSON.stringify(payload.metadataJson) : null,
      payload.acknowledgedAt || null,
      payload.acknowledgedBy || null,
      payload.resolved ? 1 : 0
    );
  }

  async listCrashEvents(limit = 50, unresolvedOnly = false) {
    const where = unresolvedOnly ? "WHERE resolved = 0" : "";
    return this.db
      .prepare(`SELECT * FROM crash_events ${where} ORDER BY occurredAt DESC LIMIT ?`)
      .all(Number(limit))
      .map((row) => ({
        ...row,
        metadataJson: row.metadataJson ? JSON.parse(row.metadataJson) : null
      }));
  }

  async getCrashEventById(id) {
    const row = this.db.prepare("SELECT * FROM crash_events WHERE id = ? LIMIT 1").get(id);
    if (!row) return null;
    return {
      ...row,
      metadataJson: row.metadataJson ? JSON.parse(row.metadataJson) : null
    };
  }

  async acknowledgeCrashEvent(id, by) {
    this.db.prepare("UPDATE crash_events SET resolved = 1, acknowledgedAt = ?, acknowledgedBy = ? WHERE id = ?").run(nowIso(), by || null, id);
    return this.getCrashEventById(id);
  }

  async createMagicLink({ email, tokenHash, expiresAt, requestedIp }) {
    this.db.prepare(`
      INSERT INTO auth_magic_links (email, tokenHash, expiresAt, createdAt, requestedIp)
      VALUES (?, ?, ?, ?, ?)
    `).run(email, tokenHash, expiresAt, nowIso(), requestedIp || null);
  }

  async consumeMagicLink(tokenHash) {
    const row = this.db.prepare("SELECT * FROM auth_magic_links WHERE tokenHash = ? LIMIT 1").get(tokenHash);
    if (!row || row.usedAt) return null;
    if (Date.parse(row.expiresAt) < Date.now()) return null;
    this.db.prepare("UPDATE auth_magic_links SET usedAt = ? WHERE id = ?").run(nowIso(), row.id);
    return row;
  }

  async createAuthSession({ userId, tokenHash, expiresAt, userAgent, ip }) {
    const now = nowIso();
    this.db.prepare(`
      INSERT INTO auth_sessions (userId, tokenHash, createdAt, expiresAt, lastSeenAt, userAgent, ip)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(userId, tokenHash, now, expiresAt, now, userAgent || null, ip || null);
  }

  async getAuthSessionByTokenHash(tokenHash) {
    const row = this.db.prepare(`
      SELECT s.*, u.id as userIdReal, u.externalSubject, u.email, u.displayName, u.avatarUrl, u.role, u.isActive
      FROM auth_sessions s
      JOIN users u ON u.id = s.userId
      WHERE s.tokenHash = ? AND s.revokedAt IS NULL
      LIMIT 1
    `).get(tokenHash);
    if (!row) return null;
    if (Date.parse(row.expiresAt) < Date.now()) return null;
    return row;
  }

  async touchAuthSession(tokenHash) {
    this.db.prepare("UPDATE auth_sessions SET lastSeenAt = ? WHERE tokenHash = ?").run(nowIso(), tokenHash);
  }

  async revokeAuthSession(tokenHash) {
    this.db.prepare("UPDATE auth_sessions SET revokedAt = ? WHERE tokenHash = ?").run(nowIso(), tokenHash);
  }

  async revokeAuthSessionsForUser(userId) {
    this.db.prepare("UPDATE auth_sessions SET revokedAt = ? WHERE userId = ? AND revokedAt IS NULL").run(nowIso(), userId);
  }

  async cleanupAuthSessions() {
    this.db.prepare("DELETE FROM auth_sessions WHERE revokedAt IS NOT NULL OR expiresAt < ?").run(nowIso());
    this.db.prepare("DELETE FROM password_resets WHERE usedAt IS NOT NULL OR expiresAt < ?").run(nowIso());
  }

  async createLanguagePack({ language, type, topic, status, createdBy }) {
    const now = nowIso();
    const result = this.db.prepare(`
      INSERT INTO packs (language, type, topic, status, createdBy, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(language, type, topic || null, status || "DRAFT", createdBy || null, now, now);
    return result.lastInsertRowid;
  }

  async replaceLanguagePackItems(packId, items = []) {
    const tx = this.db.transaction(() => {
      this.db.prepare("DELETE FROM pack_items WHERE packId = ?").run(packId);
      const stmt = this.db.prepare("INSERT INTO pack_items (packId, text, difficulty, metadataJson) VALUES (?, ?, ?, ?)");
      for (const item of items) {
        stmt.run(packId, item.text, item.difficulty || null, item.metadataJson ? JSON.stringify(item.metadataJson) : null);
      }
      this.db.prepare("UPDATE packs SET updatedAt = ? WHERE id = ?").run(nowIso(), packId);
    });
    tx();
  }

  async updateLanguagePack(packId, { topic, status }) {
    this.db.prepare("UPDATE packs SET topic = COALESCE(?, topic), status = COALESCE(?, status), updatedAt = ? WHERE id = ?")
      .run(topic || null, status || null, nowIso(), packId);
  }

  async listLanguagePacks(filters = {}) {
    const params = [];
    let where = "WHERE 1=1";
    if (filters.language) { where += " AND language = ?"; params.push(filters.language); }
    if (filters.type) { where += " AND type = ?"; params.push(filters.type); }
    if (filters.status) { where += " AND status = ?"; params.push(filters.status); }
    return this.db.prepare(`SELECT * FROM packs ${where} ORDER BY updatedAt DESC`).all(...params);
  }

  async getLanguagePackById(id) {
    return this.db.prepare("SELECT * FROM packs WHERE id = ? LIMIT 1").get(id) || null;
  }

  async getLanguagePackItems(packId) {
    return this.db.prepare("SELECT * FROM pack_items WHERE packId = ? ORDER BY id ASC").all(packId)
      .map((row) => ({ ...row, metadataJson: row.metadataJson ? JSON.parse(row.metadataJson) : null }));
  }

  async listPublishedLanguagesByType(type) {
    return this.db.prepare("SELECT DISTINCT language FROM packs WHERE type = ? AND status = 'PUBLISHED' ORDER BY language ASC").all(type)
      .map((row) => row.language);
  }

  async getPublishedPackItems({ language, type }) {
    return this.db.prepare(`
      SELECT i.* FROM pack_items i
      JOIN packs p ON p.id = i.packId
      WHERE p.language = ? AND p.type = ? AND p.status = 'PUBLISHED'
      ORDER BY i.id ASC
    `).all(language, type).map((row) => ({ ...row, metadataJson: row.metadataJson ? JSON.parse(row.metadataJson) : null }));
  }

  async listVocabularyPacks(filters = {}, options = {}) {
    const params = [];
    let where = "WHERE 1=1";
    if (filters.language) { where += " AND language = ?"; params.push(filters.language); }
    if (filters.level) { where += " AND level = ?"; params.push(Number(filters.level)); }
    if (filters.type) { where += " AND type = ?"; params.push(filters.type); }
    if (filters.status) { where += " AND status = ?"; params.push(filters.status); }
    if (filters.source) { where += " AND source = ?"; params.push(filters.source); }
    if (filters.search) { where += " AND (name LIKE ? OR id LIKE ?)"; params.push(`%${filters.search}%`, `%${filters.search}%`); }
    const sortable = {
      name: "name",
      language: "language",
      level: "level",
      type: "type",
      status: "status",
      source: "source",
      version: "version",
      updated: "updated_at",
      updated_at: "updated_at"
    };
    const sortBy = sortable[options.sortBy] || "updated_at";
    const sortDir = String(options.sortDir || "desc").toLowerCase() === "asc" ? "ASC" : "DESC";
    const page = Math.max(1, Number(options.page || 1));
    const pageSize = Math.max(5, Math.min(100, Number(options.pageSize || 20)));
    const offset = (page - 1) * pageSize;
    const total = Number(this.db.prepare(`SELECT COUNT(*) as c FROM vocabulary_packs ${where}`).get(...params)?.c || 0);
    const rows = this.db.prepare(`
      SELECT p.*,
             (SELECT COUNT(*) FROM vocabulary_entries e WHERE e.pack_id = p.id) AS entry_count
      FROM vocabulary_packs p
      ${where}
      ORDER BY ${sortBy} ${sortDir}, id ASC
      LIMIT ? OFFSET ?
    `).all(...params, pageSize, offset);
    return { rows, total, page, pageSize };
  }

  async getVocabularyPackById(id) {
    return this.db.prepare("SELECT * FROM vocabulary_packs WHERE id = ? LIMIT 1").get(id) || null;
  }

  async createVocabularyPack(payload) {
    this.db.prepare(`
      INSERT INTO vocabulary_packs
      (id, name, language, level, type, status, source, version, generator_config, metadata, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      payload.id,
      payload.name,
      payload.language,
      payload.level,
      payload.type,
      payload.status,
      payload.source,
      payload.version || 1,
      payload.generator_config ? JSON.stringify(payload.generator_config) : null,
      payload.metadata ? JSON.stringify(payload.metadata) : null,
      payload.created_at,
      payload.updated_at
    );
  }

  async updateVocabularyPack(id, patch = {}) {
    const current = await this.getVocabularyPackById(id);
    if (!current) return null;
    const next = {
      ...current,
      ...patch,
      generator_config: patch.generator_config === undefined ? current.generator_config : JSON.stringify(patch.generator_config || null),
      metadata: patch.metadata === undefined ? current.metadata : JSON.stringify(patch.metadata || null),
      updated_at: nowIso()
    };
    this.db.prepare(`
      UPDATE vocabulary_packs
      SET name = ?, language = ?, level = ?, type = ?, status = ?, source = ?, version = ?, generator_config = ?, metadata = ?, updated_at = ?
      WHERE id = ?
    `).run(
      next.name,
      next.language,
      next.level,
      next.type,
      next.status,
      next.source,
      next.version,
      next.generator_config,
      next.metadata,
      next.updated_at,
      id
    );
    return this.getVocabularyPackById(id);
  }

  async deleteVocabularyPack(id) {
    this.db.prepare("DELETE FROM vocabulary_packs WHERE id = ?").run(id);
  }

  async replaceVocabularyEntries(packId, entries = []) {
    const tx = this.db.transaction(() => {
      this.db.prepare("DELETE FROM vocabulary_entries WHERE pack_id = ?").run(packId);
      const stmt = this.db.prepare(`
        INSERT INTO vocabulary_entries (id, pack_id, text, order_index, difficulty_score, tags, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      for (const row of entries) {
        stmt.run(
          row.id,
          packId,
          row.text,
          row.order_index,
          row.difficulty_score ?? null,
          row.tags ? JSON.stringify(row.tags) : null,
          row.created_at
        );
      }
      this.db.prepare("UPDATE vocabulary_packs SET updated_at = ? WHERE id = ?").run(nowIso(), packId);
    });
    tx();
  }

  async listVocabularyEntries(packId) {
    return this.db.prepare("SELECT * FROM vocabulary_entries WHERE pack_id = ? ORDER BY order_index ASC, created_at ASC").all(packId)
      .map((row) => ({ ...row, tags: row.tags ? JSON.parse(row.tags) : null }));
  }

  async createVocabularyVersion(versionRow) {
    this.db.prepare(`
      INSERT INTO vocabulary_pack_versions (id, pack_id, version, snapshot_json, change_note, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      versionRow.id,
      versionRow.pack_id,
      versionRow.version,
      JSON.stringify(versionRow.snapshot_json),
      versionRow.change_note || null,
      versionRow.created_by || null,
      versionRow.created_at
    );
  }

  async listVocabularyVersions(packId) {
    return this.db.prepare("SELECT * FROM vocabulary_pack_versions WHERE pack_id = ? ORDER BY version DESC, created_at DESC").all(packId)
      .map((row) => ({ ...row, snapshot_json: row.snapshot_json ? JSON.parse(row.snapshot_json) : null }));
  }

  async upsertActiveSession({ sessionId, userId, mode, isAuthorized }) {
    const now = nowIso();
    this.db.prepare(`
      INSERT INTO active_sessions (sessionId, userId, startedAt, lastSeenAt, mode, isAuthorized)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(sessionId) DO UPDATE SET
      userId = excluded.userId,
      lastSeenAt = excluded.lastSeenAt,
      mode = excluded.mode,
      isAuthorized = excluded.isAuthorized
    `).run(sessionId, userId || null, now, now, mode, isAuthorized ? 1 : 0);
  }

  async cleanupActiveSessions(maxAgeSeconds = 120) {
    const threshold = new Date(Date.now() - maxAgeSeconds * 1000).toISOString();
    this.db.prepare("DELETE FROM active_sessions WHERE lastSeenAt < ?").run(threshold);
  }

  async getActiveSessionStats(maxAgeSeconds = 120) {
    const threshold = new Date(Date.now() - maxAgeSeconds * 1000).toISOString();
    const row = this.db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN isAuthorized = 1 THEN 1 ELSE 0 END) as authorized,
        SUM(CASE WHEN isAuthorized = 0 THEN 1 ELSE 0 END) as guests
      FROM active_sessions
      WHERE lastSeenAt >= ?
    `).get(threshold);
    const modes = this.db.prepare(`
      SELECT mode, COUNT(*) as count
      FROM active_sessions
      WHERE lastSeenAt >= ?
      GROUP BY mode
      ORDER BY count DESC
    `).all(threshold);
    return {
      total: Number(row?.total || 0),
      authorized: Number(row?.authorized || 0),
      guests: Number(row?.guests || 0),
      modes
    };
  }

  async reset(scope) {
    if (scope === "all") {
      this.db.prepare("DELETE FROM leaderboard").run();
      this.db.prepare("DELETE FROM vocab_packs").run();
      this.db.prepare("DELETE FROM settings").run();
      return;
    }
    if (scope === "leaderboard" || scope === "results") {
      this.db.prepare("DELETE FROM leaderboard").run();
      return;
    }
    if (scope === "vocab") this.db.prepare("DELETE FROM vocab_packs").run();
  }

  async clearAll() {
    await this.reset("all");
  }

  async dumpAll() {
    return {
      settings: this.db.prepare("SELECT key, value FROM settings ORDER BY key ASC").all(),
      leaderboard: this.db.prepare("SELECT * FROM leaderboard ORDER BY id ASC").all(),
      vocab_packs: this.db.prepare("SELECT * FROM vocab_packs ORDER BY id ASC").all(),
      users: this.db.prepare("SELECT * FROM users ORDER BY id ASC").all(),
      user_secrets: this.db.prepare("SELECT * FROM user_secrets ORDER BY id ASC").all(),
      app_config: this.db.prepare("SELECT * FROM app_config ORDER BY id ASC").all(),
      system_secrets: this.db.prepare("SELECT * FROM system_secrets ORDER BY secretKey ASC").all(),
      packs: this.db.prepare("SELECT * FROM packs ORDER BY id ASC").all(),
      pack_items: this.db.prepare("SELECT * FROM pack_items ORDER BY id ASC").all(),
      auth_identities: this.db.prepare("SELECT * FROM auth_identities ORDER BY id ASC").all(),
      password_resets: this.db.prepare("SELECT * FROM password_resets ORDER BY id ASC").all(),
      crash_events: this.db.prepare("SELECT * FROM crash_events ORDER BY id ASC").all()
    };
  }

  async restoreAll(dump) {
    const tx = this.db.transaction(() => {
      this.db.prepare("DELETE FROM leaderboard").run();
      this.db.prepare("DELETE FROM vocab_packs").run();
      this.db.prepare("DELETE FROM settings").run();
      this.db.prepare("DELETE FROM user_secrets").run();
      this.db.prepare("DELETE FROM users").run();
      this.db.prepare("DELETE FROM app_config").run();
      this.db.prepare("DELETE FROM system_secrets").run();
      this.db.prepare("DELETE FROM pack_items").run();
      this.db.prepare("DELETE FROM packs").run();
      this.db.prepare("DELETE FROM password_resets").run();
      this.db.prepare("DELETE FROM auth_identities").run();
      this.db.prepare("DELETE FROM crash_events").run();

      for (const row of dump.settings || []) {
        this.db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run(row.key, row.value);
      }
      for (const row of dump.vocab_packs || []) {
        this.db.prepare("INSERT INTO vocab_packs (id, name, packType, items, active, createdAt) VALUES (?, ?, ?, ?, ?, ?)")
          .run(row.id, row.name, row.packType || row.packtype, row.items, row.active, row.createdAt || row.createdat);
      }
      for (const row of dump.leaderboard || []) {
        this.db.prepare("INSERT INTO leaderboard (id, playerName, createdAt, contestType, level, contentMode, duration, taskTarget, score, accuracy, cpm, mistakes, tasksCompleted, timeSeconds, maxStreak) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
          .run(row.id, row.playerName || row.playername, row.createdAt || row.createdat, row.contestType || row.contesttype, row.level, row.contentMode || row.contentmode, row.duration, row.taskTarget || row.tasktarget, row.score, row.accuracy, row.cpm, row.mistakes, row.tasksCompleted || row.taskscompleted, row.timeSeconds || row.timeseconds, row.maxStreak || row.maxstreak);
      }
      for (const row of dump.users || []) {
        this.db.prepare("INSERT INTO users (id, externalSubject, email, displayName, avatarUrl, role, isActive, createdAt, updatedAt, lastLoginAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
          .run(row.id, row.externalSubject || row.externalsubject, row.email, row.displayName || row.displayname, row.avatarUrl || row.avatarurl || null, row.role, row.isActive || row.isactive || 1, row.createdAt || row.createdat, row.updatedAt || row.updatedat, row.lastLoginAt || row.lastloginat || null);
      }
      for (const row of dump.user_secrets || []) {
        this.db.prepare("INSERT INTO user_secrets (id, userId, secretKey, ciphertext, iv, authTag, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
          .run(row.id, row.userId || row.userid, row.secretKey || row.secretkey, row.ciphertext, row.iv, row.authTag || row.authtag, row.createdAt || row.createdat, row.updatedAt || row.updatedat);
      }
      for (const row of dump.app_config || []) {
        this.db.prepare("INSERT INTO app_config (id, key, scope, scopeId, valueJson, updatedAt, updatedBy) VALUES (?, ?, ?, ?, ?, ?, ?)")
          .run(row.id, row.key, row.scope, row.scopeId || row.scopeid, row.valueJson || row.valuejson, row.updatedAt || row.updatedat, row.updatedBy || row.updatedby || null);
      }
      for (const row of dump.system_secrets || []) {
        this.db.prepare("INSERT INTO system_secrets (secretKey, ciphertext, iv, authTag, updatedAt, updatedBy) VALUES (?, ?, ?, ?, ?, ?)")
          .run(row.secretKey || row.secretkey, row.ciphertext, row.iv, row.authTag || row.authtag, row.updatedAt || row.updatedat, row.updatedBy || row.updatedby || null);
      }
      for (const row of dump.packs || []) {
        this.db.prepare("INSERT INTO packs (id, language, type, topic, status, createdBy, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
          .run(row.id, row.language, row.type, row.topic || null, row.status, row.createdBy || row.createdby || null, row.createdAt || row.createdat, row.updatedAt || row.updatedat);
      }
      for (const row of dump.pack_items || []) {
        this.db.prepare("INSERT INTO pack_items (id, packId, text, difficulty, metadataJson) VALUES (?, ?, ?, ?, ?)")
          .run(row.id, row.packId || row.packid, row.text, row.difficulty || null, row.metadataJson || row.metadatajson || null);
      }
      for (const row of dump.auth_identities || []) {
        this.db.prepare("INSERT INTO auth_identities (id, userId, provider, providerSubject, passwordHash, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)")
          .run(row.id, row.userId || row.userid, row.provider, row.providerSubject || row.providersubject || null, row.passwordHash || row.passwordhash || null, row.createdAt || row.createdat, row.updatedAt || row.updatedat);
      }
      for (const row of dump.password_resets || []) {
        this.db.prepare("INSERT INTO password_resets (id, userId, tokenHash, expiresAt, usedAt, createdAt, requestedIp) VALUES (?, ?, ?, ?, ?, ?, ?)")
          .run(row.id, row.userId || row.userid, row.tokenHash || row.tokenhash, row.expiresAt || row.expiresat, row.usedAt || row.usedat || null, row.createdAt || row.createdat, row.requestedIp || row.requestedip || null);
      }
      for (const row of dump.crash_events || []) {
        this.db.prepare("INSERT INTO crash_events (id, occurredAt, appVersion, appBuild, appCommit, appMode, crashType, startupPhase, errorName, errorMessage, stackTrace, hostname, uptimeSeconds, metadataJson, acknowledgedAt, acknowledgedBy, resolved) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
          .run(
            row.id,
            row.occurredAt || row.occurredat,
            row.appVersion || row.appversion || null,
            row.appBuild || row.appbuild || null,
            row.appCommit || row.appcommit || null,
            row.appMode || row.appmode || null,
            row.crashType || row.crashtype,
            row.startupPhase || row.startupphase || null,
            row.errorName || row.errorname || null,
            row.errorMessage || row.errormessage || null,
            row.stackTrace || row.stacktrace || null,
            row.hostname || null,
            row.uptimeSeconds || row.uptimeseconds || null,
            row.metadataJson || row.metadatajson || null,
            row.acknowledgedAt || row.acknowledgedat || null,
            row.acknowledgedBy || row.acknowledgedby || null,
            row.resolved || 0
          );
      }

      this.db.prepare("DELETE FROM sqlite_sequence WHERE name IN ('leaderboard', 'vocab_packs', 'users', 'user_secrets', 'app_config', 'audit_log', 'packs', 'pack_items', 'auth_magic_links', 'auth_sessions', 'auth_identities', 'password_resets', 'crash_events')").run();
    });
    tx();
  }

  async counts() {
    const settings = this.db.prepare("SELECT COUNT(*) as c FROM settings").get().c;
    const leaderboard = this.db.prepare("SELECT COUNT(*) as c FROM leaderboard").get().c;
    const vocab_packs = this.db.prepare("SELECT COUNT(*) as c FROM vocab_packs").get().c;
    const users = this.db.prepare("SELECT COUNT(*) as c FROM users").get().c;
    const app_config = this.db.prepare("SELECT COUNT(*) as c FROM app_config").get().c;
    const packs = this.db.prepare("SELECT COUNT(*) as c FROM packs").get().c;
    const crashes = this.db.prepare("SELECT COUNT(*) as c FROM crash_events").get().c;
    return { settings, leaderboard, vocab_packs, users, app_config, packs, crashes };
  }
}

module.exports = { SqliteAdapter };
