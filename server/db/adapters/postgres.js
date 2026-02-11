const { Pool } = require("pg");

function nowIso() {
  return new Date().toISOString();
}

function mapUserRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    externalSubject: row.externalsubject || row.externalSubject,
    email: row.email,
    displayName: row.displayname || row.displayName,
    role: row.role,
    isActive: row.isactive ?? row.isActive,
    createdAt: row.createdat || row.createdAt,
    updatedAt: row.updatedat || row.updatedAt,
    lastLoginAt: row.lastloginat || row.lastLoginAt,
    avatarUrl: row.avatarurl || row.avatarUrl
  };
}

class PostgresAdapter {
  constructor({ migrationSql, postgres }) {
    this.driver = "postgres";
    this.migrationSql = migrationSql;
    this.pool = new Pool({
      max: Number(process.env.POSTGRES_POOL_MAX || 20),
      idleTimeoutMillis: Number(process.env.POSTGRES_IDLE_TIMEOUT_MS || 30000),
      connectionTimeoutMillis: Number(process.env.POSTGRES_CONNECT_TIMEOUT_MS || 10000),
      ...postgres
    });
  }

  async init() {
    if (this.migrationSql) await this.pool.query(this.migrationSql);
  }

  async close() {
    await this.pool.end();
  }

  async ping() {
    await this.pool.query("SELECT 1");
    return true;
  }

  async runMigrations(migrations) {
    await this.pool.query("CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, appliedAt TEXT NOT NULL)");
    const existing = await this.pool.query("SELECT id FROM schema_migrations");
    const applied = new Set(existing.rows.map((row) => row.id));

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      for (const migration of migrations) {
        if (applied.has(migration.id)) continue;
        await client.query(migration.sql);
        await client.query("INSERT INTO schema_migrations (id, appliedAt) VALUES ($1, $2)", [migration.id, nowIso()]);
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
    const status = await this.pool.query("SELECT id, appliedAt FROM schema_migrations ORDER BY id ASC");
    return status.rows;
  }

  async getAppliedMigrations() {
    await this.pool.query("CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, appliedAt TEXT NOT NULL)");
    const { rows } = await this.pool.query("SELECT id, appliedAt FROM schema_migrations ORDER BY id ASC");
    return rows;
  }

  async rollbackMigration(id, downSql) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(downSql);
      await client.query("DELETE FROM schema_migrations WHERE id = $1", [id]);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  async hasIndex(indexName) {
    const { rows } = await this.pool.query("SELECT 1 as ok FROM pg_indexes WHERE indexname = $1", [indexName]);
    return Boolean(rows[0]?.ok);
  }

  async getSetting(key) {
    const { rows } = await this.pool.query("SELECT value FROM settings WHERE key = $1", [key]);
    return rows[0] ? rows[0].value : null;
  }

  async setSetting(key, value) {
    await this.pool.query("INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value", [key, value]);
  }

  async insertLeaderboard(payload) {
    await this.pool.query(
      `INSERT INTO leaderboard
      (playerName, createdAt, contestType, level, contentMode, duration, taskTarget, score, accuracy, cpm, mistakes, tasksCompleted, timeSeconds, maxStreak, userId, isGuest, language, displayName, avatarUrl)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
      [
        payload.playerName,
        payload.createdAt,
        payload.contestType,
        payload.level,
        payload.contentMode,
        payload.duration,
        payload.taskTarget,
        payload.score,
        payload.accuracy,
        payload.cpm,
        payload.mistakes,
        payload.tasksCompleted,
        payload.timeSeconds,
        payload.maxStreak,
        payload.userId || null,
        payload.isGuest ? 1 : 0,
        payload.language || "en",
        payload.displayName || null,
        payload.avatarUrl || null
      ]
    );
  }

  async queryLeaderboard(filters) {
    const params = [];
    let i = 1;
    let where = "WHERE 1=1";
    if (filters.contestType) { where += ` AND contestType = $${i++}`; params.push(filters.contestType); }
    if (filters.level) { where += ` AND level = $${i++}`; params.push(Number(filters.level)); }
    if (filters.contentMode) { where += ` AND contentMode = $${i++}`; params.push(filters.contentMode); }
    if (filters.duration && filters.contestType === "time") { where += ` AND duration = $${i++}`; params.push(Number(filters.duration)); }
    if (filters.taskTarget && filters.contestType === "tasks") { where += ` AND taskTarget = $${i++}`; params.push(Number(filters.taskTarget)); }
    if (filters.onlyAuthorized) { where += " AND isGuest = 0"; }
    if (filters.language) { where += ` AND language = $${i++}`; params.push(filters.language); }
    const { rows } = await this.pool.query(`SELECT * FROM leaderboard ${where} ORDER BY score DESC, accuracy DESC LIMIT 20`, params);
    return rows;
  }

  async getGamePreferences(userId) {
    const { rows } = await this.pool.query("SELECT * FROM game_preferences WHERE userId = $1 LIMIT 1", [userId]);
    return rows[0] || null;
  }

  async upsertGamePreferences({ userId, mode, level, contentType, language, updatedAt }) {
    await this.pool.query(
      `INSERT INTO game_preferences (userId, mode, level, contentType, language, updatedAt)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT(userId) DO UPDATE SET
         mode = EXCLUDED.mode,
         level = EXCLUDED.level,
         contentType = EXCLUDED.contentType,
         language = EXCLUDED.language,
         updatedAt = EXCLUDED.updatedAt`,
      [userId, mode, level, contentType, language, updatedAt]
    );
  }

  async getPlayerStats(userId) {
    const { rows } = await this.pool.query("SELECT * FROM player_stats WHERE userId = $1 LIMIT 1", [userId]);
    return rows[0] || null;
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
    await this.pool.query(
      `INSERT INTO player_stats
      (userId, totalLettersTyped, totalCorrect, totalIncorrect, bestWPM, sessionsCount, totalPlayTimeMs, streakDays, lastSessionAt)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      ON CONFLICT(userId) DO UPDATE SET
        totalLettersTyped = EXCLUDED.totalLettersTyped,
        totalCorrect = EXCLUDED.totalCorrect,
        totalIncorrect = EXCLUDED.totalIncorrect,
        bestWPM = EXCLUDED.bestWPM,
        sessionsCount = EXCLUDED.sessionsCount,
        totalPlayTimeMs = EXCLUDED.totalPlayTimeMs,
        streakDays = EXCLUDED.streakDays,
        lastSessionAt = EXCLUDED.lastSessionAt`,
      [userId, totalLettersTyped, totalCorrect, totalIncorrect, bestWPM, sessionsCount, totalPlayTimeMs, streakDays, lastSessionAt || null]
    );
  }

  async listPacks() {
    const { rows } = await this.pool.query("SELECT * FROM vocab_packs ORDER BY createdAt DESC");
    return rows;
  }

  async getPackById(id) {
    const { rows } = await this.pool.query("SELECT * FROM vocab_packs WHERE id = $1", [id]);
    return rows[0] || null;
  }

  async getActivePack(packType) {
    const { rows } = await this.pool.query("SELECT * FROM vocab_packs WHERE packType = $1 AND active = 1 ORDER BY id DESC LIMIT 1", [packType]);
    return rows[0] || null;
  }

  async activatePack(id, packType) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("UPDATE vocab_packs SET active = 0 WHERE packType = $1", [packType]);
      await client.query("UPDATE vocab_packs SET active = 1 WHERE id = $1", [id]);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  async updatePack(id, name, itemsJson) {
    await this.pool.query("UPDATE vocab_packs SET name = COALESCE($1, name), items = $2 WHERE id = $3", [name || null, itemsJson, id]);
  }

  async deletePack(id) {
    await this.pool.query("DELETE FROM vocab_packs WHERE id = $1", [id]);
  }

  async insertPack({ name, packType, itemsJson, active, createdAt }) {
    await this.pool.query("INSERT INTO vocab_packs (name, packType, items, active, createdAt) VALUES ($1, $2, $3, $4, $5)", [name, packType, itemsJson, active ? 1 : 0, createdAt]);
  }

  async findUserByExternalSubject(externalSubject) {
    const { rows } = await this.pool.query("SELECT * FROM users WHERE externalSubject = $1 LIMIT 1", [externalSubject]);
    return mapUserRow(rows[0]);
  }

  async findUserByEmail(email) {
    const { rows } = await this.pool.query("SELECT * FROM users WHERE lower(email) = lower($1) LIMIT 1", [email]);
    return mapUserRow(rows[0]);
  }

  async findUserByDisplayName(displayName) {
    const { rows } = await this.pool.query(
      "SELECT * FROM users WHERE lower(trim(displayName)) = lower(trim($1)) LIMIT 1",
      [displayName]
    );
    return mapUserRow(rows[0]);
  }

  async findUserById(id) {
    const { rows } = await this.pool.query("SELECT * FROM users WHERE id = $1 LIMIT 1", [id]);
    return mapUserRow(rows[0]);
  }

  async getOwnerUser() {
    const { rows } = await this.pool.query("SELECT * FROM users WHERE role = 'OWNER' ORDER BY id ASC LIMIT 1");
    return mapUserRow(rows[0]);
  }

  async createUser({ externalSubject, email, displayName, role, avatarUrl }) {
    const now = nowIso();
    const { rows } = await this.pool.query(
      `INSERT INTO users (externalSubject, email, displayName, avatarUrl, role, isActive, createdAt, updatedAt, lastLoginAt)
       VALUES ($1, $2, $3, $4, $5, 1, $6, $6, $6)
       RETURNING *`,
      [externalSubject, email || null, displayName || null, avatarUrl || null, role, now]
    );
    return mapUserRow(rows[0]);
  }

  async listUsers() {
    const { rows } = await this.pool.query("SELECT id, externalSubject, email, displayName, avatarUrl, role, isActive, createdAt, updatedAt, lastLoginAt FROM users ORDER BY id ASC");
    return rows.map(mapUserRow);
  }

  async updateUserRole(id, role) {
    const { rows } = await this.pool.query("UPDATE users SET role = $1, updatedAt = $2 WHERE id = $3 RETURNING *", [role, nowIso(), id]);
    return mapUserRow(rows[0]);
  }

  async touchUserLogin(id) {
    await this.pool.query("UPDATE users SET lastLoginAt = $1, updatedAt = $1 WHERE id = $2", [nowIso(), id]);
  }

  async updateUserProfile(id, { displayName, avatarUrl }) {
    await this.pool.query("UPDATE users SET displayName = COALESCE($1, displayName), avatarUrl = COALESCE($2, avatarUrl), updatedAt = $3 WHERE id = $4", [displayName || null, avatarUrl || null, nowIso(), id]);
    if (avatarUrl !== undefined) {
      await this.setConfig("user.avatar", "user", String(id), { avatarUrl: avatarUrl || "" }, `user:${id}`);
    }
    return this.findUserById(id);
  }

  async findAuthIdentity({ provider, providerSubject }) {
    const { rows } = await this.pool.query("SELECT * FROM auth_identities WHERE provider = $1 AND providerSubject = $2 LIMIT 1", [provider, providerSubject]);
    return rows[0] || null;
  }

  async findPasswordIdentityByEmail(email) {
    const { rows } = await this.pool.query(
      `SELECT ai.*, u.email, u.displayName, u.avatarUrl, u.role, u.isActive, u.id as userId
       FROM auth_identities ai
       JOIN users u ON u.id = ai.userId
       WHERE ai.provider = 'password' AND lower(u.email) = lower($1)
       LIMIT 1`,
      [email]
    );
    return rows[0] || null;
  }

  async upsertAuthIdentity({ userId, provider, providerSubject, passwordHash }) {
    const now = nowIso();
    await this.pool.query(
      `INSERT INTO auth_identities (userId, provider, providerSubject, passwordHash, createdAt, updatedAt)
       VALUES ($1,$2,$3,$4,$5,$5)
       ON CONFLICT(userId, provider) DO UPDATE SET
       providerSubject = EXCLUDED.providerSubject,
       passwordHash = COALESCE(EXCLUDED.passwordHash, auth_identities.passwordHash),
       updatedAt = EXCLUDED.updatedAt`,
      [userId, provider, providerSubject || null, passwordHash || null, now]
    );
  }

  async createPasswordReset({ userId, tokenHash, expiresAt, requestedIp }) {
    await this.pool.query(
      "INSERT INTO password_resets (userId, tokenHash, expiresAt, usedAt, createdAt, requestedIp) VALUES ($1,$2,$3,NULL,$4,$5)",
      [userId, tokenHash, expiresAt, nowIso(), requestedIp || null]
    );
  }

  async consumePasswordReset(tokenHash) {
    const { rows } = await this.pool.query("SELECT * FROM password_resets WHERE tokenHash = $1 LIMIT 1", [tokenHash]);
    const row = rows[0];
    if (!row || row.usedat) return null;
    if (Date.parse(row.expiresat) < Date.now()) return null;
    await this.pool.query("UPDATE password_resets SET usedAt = $1 WHERE id = $2", [nowIso(), row.id]);
    return row;
  }

  async getUserSecret(userId, secretKey) {
    const { rows } = await this.pool.query("SELECT * FROM user_secrets WHERE userId = $1 AND secretKey = $2 LIMIT 1", [userId, secretKey]);
    return rows[0] || null;
  }

  async upsertUserSecret(userId, secretKey, encrypted) {
    const now = nowIso();
    await this.pool.query(
      `INSERT INTO user_secrets (userId, secretKey, ciphertext, iv, authTag, createdAt, updatedAt)
       VALUES ($1, $2, $3, $4, $5, $6, $6)
       ON CONFLICT(userId, secretKey) DO UPDATE SET
       ciphertext = EXCLUDED.ciphertext,
       iv = EXCLUDED.iv,
       authTag = EXCLUDED.authTag,
       updatedAt = EXCLUDED.updatedAt`,
      [userId, secretKey, encrypted.ciphertext, encrypted.iv, encrypted.authTag, now]
    );
  }

  async setSystemSecret(secretKey, encrypted, updatedBy) {
    await this.pool.query(
      `INSERT INTO system_secrets (secretKey, ciphertext, iv, authTag, updatedAt, updatedBy)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT(secretKey) DO UPDATE SET
       ciphertext = EXCLUDED.ciphertext,
       iv = EXCLUDED.iv,
       authTag = EXCLUDED.authTag,
       updatedAt = EXCLUDED.updatedAt,
       updatedBy = EXCLUDED.updatedBy`,
      [secretKey, encrypted.ciphertext, encrypted.iv, encrypted.authTag, nowIso(), updatedBy || null]
    );
  }

  async getSystemSecret(secretKey) {
    const { rows } = await this.pool.query("SELECT * FROM system_secrets WHERE secretKey = $1 LIMIT 1", [secretKey]);
    return rows[0] || null;
  }

  async setConfig(key, scope, scopeId, valueJson, updatedBy) {
    await this.pool.query(
      `INSERT INTO app_config (key, scope, scopeId, valueJson, updatedAt, updatedBy)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT(key, scope, scopeId) DO UPDATE SET
       valueJson = EXCLUDED.valueJson,
       updatedAt = EXCLUDED.updatedAt,
       updatedBy = EXCLUDED.updatedBy`,
      [key, scope, scopeId, JSON.stringify(valueJson), nowIso(), updatedBy || null]
    );
  }

  async getConfig(key, scope, scopeId) {
    const { rows } = await this.pool.query("SELECT * FROM app_config WHERE key = $1 AND scope = $2 AND scopeId = $3 LIMIT 1", [key, scope, scopeId]);
    if (!rows[0]) return null;
    return { ...rows[0], scopeId: rows[0].scopeid, valueJson: JSON.parse(rows[0].valuejson) };
  }

  async listConfig(scope, scopeId) {
    const { rows } = await this.pool.query("SELECT * FROM app_config WHERE scope = $1 AND scopeId = $2 ORDER BY key ASC", [scope, scopeId]);
    return rows.map((row) => ({ ...row, scopeId: row.scopeid, valueJson: JSON.parse(row.valuejson) }));
  }

  async insertAuditLog(payload) {
    await this.pool.query(
      `INSERT INTO audit_log (actorUserId, actorRole, action, targetType, targetId, metadata, requestId, ip, createdAt)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [payload.actorUserId || null, payload.actorRole || null, payload.action, payload.targetType || null, payload.targetId || null, payload.metadata ? JSON.stringify(payload.metadata) : null, payload.requestId || null, payload.ip || null, payload.createdAt || nowIso()]
    );
  }

  async listAuditLogs(limit = 100) {
    const { rows } = await this.pool.query("SELECT * FROM audit_log ORDER BY id DESC LIMIT $1", [Number(limit)]);
    return rows.map((row) => ({ ...row, actorUserId: row.actoruserid, actorRole: row.actorrole, targetType: row.targettype, targetId: row.targetid, requestId: row.requestid, createdAt: row.createdat, metadata: row.metadata ? JSON.parse(row.metadata) : null }));
  }

  async insertCrashEvent(payload) {
    await this.pool.query(
      `INSERT INTO crash_events
      (occurredAt, appVersion, appBuild, appCommit, appMode, crashType, startupPhase, errorName, errorMessage, stackTrace, hostname, uptimeSeconds, metadataJson, acknowledgedAt, acknowledgedBy, resolved)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [
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
      ]
    );
  }

  async listCrashEvents(limit = 50, unresolvedOnly = false) {
    const where = unresolvedOnly ? "WHERE resolved = 0" : "";
    const { rows } = await this.pool.query(`SELECT * FROM crash_events ${where} ORDER BY occurredAt DESC LIMIT $1`, [Number(limit)]);
    return rows.map((row) => ({
      ...row,
      occurredAt: row.occurredat,
      appVersion: row.appversion,
      appBuild: row.appbuild,
      appCommit: row.appcommit,
      appMode: row.appmode,
      crashType: row.crashtype,
      startupPhase: row.startupphase,
      errorName: row.errorname,
      errorMessage: row.errormessage,
      stackTrace: row.stacktrace,
      uptimeSeconds: row.uptimeseconds,
      metadataJson: row.metadatajson ? JSON.parse(row.metadatajson) : null,
      acknowledgedAt: row.acknowledgedat,
      acknowledgedBy: row.acknowledgedby
    }));
  }

  async getCrashEventById(id) {
    const { rows } = await this.pool.query("SELECT * FROM crash_events WHERE id = $1 LIMIT 1", [id]);
    const row = rows[0];
    if (!row) return null;
    return {
      ...row,
      occurredAt: row.occurredat,
      appVersion: row.appversion,
      appBuild: row.appbuild,
      appCommit: row.appcommit,
      appMode: row.appmode,
      crashType: row.crashtype,
      startupPhase: row.startupphase,
      errorName: row.errorname,
      errorMessage: row.errormessage,
      stackTrace: row.stacktrace,
      uptimeSeconds: row.uptimeseconds,
      metadataJson: row.metadatajson ? JSON.parse(row.metadatajson) : null,
      acknowledgedAt: row.acknowledgedat,
      acknowledgedBy: row.acknowledgedby
    };
  }

  async acknowledgeCrashEvent(id, by) {
    await this.pool.query("UPDATE crash_events SET resolved = 1, acknowledgedAt = $1, acknowledgedBy = $2 WHERE id = $3", [nowIso(), by || null, id]);
    return this.getCrashEventById(id);
  }

  async createMagicLink({ email, tokenHash, expiresAt, requestedIp }) {
    await this.pool.query("INSERT INTO auth_magic_links (email, tokenHash, expiresAt, createdAt, requestedIp) VALUES ($1,$2,$3,$4,$5)", [email, tokenHash, expiresAt, nowIso(), requestedIp || null]);
  }

  async consumeMagicLink(tokenHash) {
    const { rows } = await this.pool.query("SELECT * FROM auth_magic_links WHERE tokenHash = $1 LIMIT 1", [tokenHash]);
    const row = rows[0];
    if (!row || row.usedat) return null;
    if (Date.parse(row.expiresat) < Date.now()) return null;
    await this.pool.query("UPDATE auth_magic_links SET usedAt = $1 WHERE id = $2", [nowIso(), row.id]);
    return { ...row, email: row.email };
  }

  async createAuthSession({ userId, tokenHash, expiresAt, userAgent, ip }) {
    const now = nowIso();
    await this.pool.query("INSERT INTO auth_sessions (userId, tokenHash, createdAt, expiresAt, lastSeenAt, userAgent, ip) VALUES ($1,$2,$3,$4,$3,$5,$6)", [userId, tokenHash, now, expiresAt, userAgent || null, ip || null]);
  }

  async getAuthSessionByTokenHash(tokenHash) {
    const { rows } = await this.pool.query(
      `SELECT s.*, u.* FROM auth_sessions s
       JOIN users u ON u.id = s.userId
       WHERE s.tokenHash = $1 AND s.revokedAt IS NULL
       LIMIT 1`,
      [tokenHash]
    );
    if (!rows[0]) return null;
    if (Date.parse(rows[0].expiresat) < Date.now()) return null;
    return rows[0];
  }

  async touchAuthSession(tokenHash) {
    await this.pool.query("UPDATE auth_sessions SET lastSeenAt = $1 WHERE tokenHash = $2", [nowIso(), tokenHash]);
  }

  async revokeAuthSession(tokenHash) {
    await this.pool.query("UPDATE auth_sessions SET revokedAt = $1 WHERE tokenHash = $2", [nowIso(), tokenHash]);
  }

  async revokeAuthSessionsForUser(userId) {
    await this.pool.query("UPDATE auth_sessions SET revokedAt = $1 WHERE userId = $2 AND revokedAt IS NULL", [nowIso(), userId]);
  }

  async cleanupAuthSessions() {
    await this.pool.query("DELETE FROM auth_sessions WHERE revokedAt IS NOT NULL OR expiresAt < $1", [nowIso()]);
    await this.pool.query("DELETE FROM password_resets WHERE usedAt IS NOT NULL OR expiresAt < $1", [nowIso()]);
  }

  async createLanguagePack({ language, type, topic, status, createdBy }) {
    const now = nowIso();
    const { rows } = await this.pool.query(
      "INSERT INTO packs (language, type, topic, status, createdBy, createdAt, updatedAt) VALUES ($1,$2,$3,$4,$5,$6,$6) RETURNING id",
      [language, type, topic || null, status || "DRAFT", createdBy || null, now]
    );
    return rows[0].id;
  }

  async replaceLanguagePackItems(packId, items = []) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM pack_items WHERE packId = $1", [packId]);
      for (const item of items) {
        await client.query("INSERT INTO pack_items (packId, text, difficulty, metadataJson) VALUES ($1,$2,$3,$4)", [packId, item.text, item.difficulty || null, item.metadataJson ? JSON.stringify(item.metadataJson) : null]);
      }
      await client.query("UPDATE packs SET updatedAt = $1 WHERE id = $2", [nowIso(), packId]);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  async updateLanguagePack(packId, { topic, status }) {
    await this.pool.query("UPDATE packs SET topic = COALESCE($1, topic), status = COALESCE($2, status), updatedAt = $3 WHERE id = $4", [topic || null, status || null, nowIso(), packId]);
  }

  async listLanguagePacks(filters = {}) {
    const params = [];
    let i = 1;
    let where = "WHERE 1=1";
    if (filters.language) { where += ` AND language = $${i++}`; params.push(filters.language); }
    if (filters.type) { where += ` AND type = $${i++}`; params.push(filters.type); }
    if (filters.status) { where += ` AND status = $${i++}`; params.push(filters.status); }
    const { rows } = await this.pool.query(`SELECT * FROM packs ${where} ORDER BY updatedAt DESC`, params);
    return rows;
  }

  async getLanguagePackById(id) {
    const { rows } = await this.pool.query("SELECT * FROM packs WHERE id = $1 LIMIT 1", [id]);
    return rows[0] || null;
  }

  async getLanguagePackItems(packId) {
    const { rows } = await this.pool.query("SELECT * FROM pack_items WHERE packId = $1 ORDER BY id ASC", [packId]);
    return rows.map((row) => ({ ...row, metadataJson: row.metadatajson ? JSON.parse(row.metadatajson) : null }));
  }

  async listPublishedLanguagesByType(type) {
    const { rows } = await this.pool.query("SELECT DISTINCT language FROM packs WHERE type = $1 AND status = 'PUBLISHED' ORDER BY language ASC", [type]);
    return rows.map((row) => row.language);
  }

  async getPublishedPackItems({ language, type }) {
    const { rows } = await this.pool.query(
      `SELECT i.* FROM pack_items i
       JOIN packs p ON p.id = i.packId
       WHERE p.language = $1 AND p.type = $2 AND p.status = 'PUBLISHED'
       ORDER BY i.id ASC`,
      [language, type]
    );
    return rows.map((row) => ({ ...row, metadataJson: row.metadatajson ? JSON.parse(row.metadatajson) : null }));
  }

  async upsertActiveSession({ sessionId, userId, mode, isAuthorized }) {
    const now = nowIso();
    await this.pool.query(
      `INSERT INTO active_sessions (sessionId, userId, startedAt, lastSeenAt, mode, isAuthorized)
       VALUES ($1,$2,$3,$3,$4,$5)
       ON CONFLICT(sessionId) DO UPDATE SET
       userId = EXCLUDED.userId,
       lastSeenAt = EXCLUDED.lastSeenAt,
       mode = EXCLUDED.mode,
       isAuthorized = EXCLUDED.isAuthorized`,
      [sessionId, userId || null, now, mode, isAuthorized ? 1 : 0]
    );
  }

  async cleanupActiveSessions(maxAgeSeconds = 120) {
    const threshold = new Date(Date.now() - maxAgeSeconds * 1000).toISOString();
    await this.pool.query("DELETE FROM active_sessions WHERE lastSeenAt < $1", [threshold]);
  }

  async getActiveSessionStats(maxAgeSeconds = 120) {
    const threshold = new Date(Date.now() - maxAgeSeconds * 1000).toISOString();
    const totals = await this.pool.query(
      `SELECT COUNT(*)::int as total,
              COALESCE(SUM(CASE WHEN isAuthorized = 1 THEN 1 ELSE 0 END),0)::int as authorized,
              COALESCE(SUM(CASE WHEN isAuthorized = 0 THEN 1 ELSE 0 END),0)::int as guests
       FROM active_sessions WHERE lastSeenAt >= $1`,
      [threshold]
    );
    const modes = await this.pool.query(
      "SELECT mode, COUNT(*)::int as count FROM active_sessions WHERE lastSeenAt >= $1 GROUP BY mode ORDER BY count DESC",
      [threshold]
    );
    return { ...totals.rows[0], modes: modes.rows };
  }

  async reset(scope) {
    if (scope === "all") {
      await this.pool.query("TRUNCATE TABLE leaderboard, vocab_packs, settings RESTART IDENTITY");
      return;
    }
    if (scope === "leaderboard" || scope === "results") {
      await this.pool.query("TRUNCATE TABLE leaderboard RESTART IDENTITY");
      return;
    }
    if (scope === "vocab") await this.pool.query("TRUNCATE TABLE vocab_packs RESTART IDENTITY");
  }

  async clearAll() {
    await this.reset("all");
  }

  async dumpAll() {
    const [settings, leaderboard, vocab_packs, users, user_secrets, app_config, system_secrets, packs, pack_items, auth_identities, password_resets, crash_events] = await Promise.all([
      this.pool.query("SELECT key, value FROM settings ORDER BY key ASC"),
      this.pool.query("SELECT * FROM leaderboard ORDER BY id ASC"),
      this.pool.query("SELECT * FROM vocab_packs ORDER BY id ASC"),
      this.pool.query("SELECT * FROM users ORDER BY id ASC"),
      this.pool.query("SELECT * FROM user_secrets ORDER BY id ASC"),
      this.pool.query("SELECT * FROM app_config ORDER BY id ASC"),
      this.pool.query("SELECT * FROM system_secrets ORDER BY secretKey ASC"),
      this.pool.query("SELECT * FROM packs ORDER BY id ASC"),
      this.pool.query("SELECT * FROM pack_items ORDER BY id ASC"),
      this.pool.query("SELECT * FROM auth_identities ORDER BY id ASC"),
      this.pool.query("SELECT * FROM password_resets ORDER BY id ASC"),
      this.pool.query("SELECT * FROM crash_events ORDER BY id ASC")
    ]);
    return { settings: settings.rows, leaderboard: leaderboard.rows, vocab_packs: vocab_packs.rows, users: users.rows, user_secrets: user_secrets.rows, app_config: app_config.rows, system_secrets: system_secrets.rows, packs: packs.rows, pack_items: pack_items.rows, auth_identities: auth_identities.rows, password_resets: password_resets.rows, crash_events: crash_events.rows };
  }

  async restoreAll(dump) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("TRUNCATE TABLE leaderboard, vocab_packs, settings, user_secrets, users, app_config, system_secrets, pack_items, packs, auth_identities, password_resets, crash_events RESTART IDENTITY CASCADE");
      for (const row of dump.settings || []) await client.query("INSERT INTO settings (key, value) VALUES ($1, $2)", [row.key, row.value]);
      for (const row of dump.vocab_packs || []) await client.query("INSERT INTO vocab_packs (id, name, packType, items, active, createdAt) VALUES ($1, $2, $3, $4, $5, $6)", [row.id, row.name, row.packType || row.packtype, row.items, row.active, row.createdat || row.createdAt]);
      for (const row of dump.leaderboard || []) {
        await client.query(
          "INSERT INTO leaderboard (id, playerName, createdAt, contestType, level, contentMode, duration, taskTarget, score, accuracy, cpm, mistakes, tasksCompleted, timeSeconds, maxStreak, userId, isGuest, language, displayName, avatarUrl) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)",
          [row.id, row.playername || row.playerName, row.createdat || row.createdAt, row.contesttype || row.contestType, row.level, row.contentmode || row.contentMode, row.duration, row.tasktarget || row.taskTarget, row.score, row.accuracy, row.cpm, row.mistakes, row.taskscompleted || row.tasksCompleted, row.timeseconds || row.timeSeconds, row.maxstreak || row.maxStreak, row.userid || row.userId || null, row.isguest || row.isGuest || 1, row.language || "en", row.displayname || row.displayName || null, row.avatarurl || row.avatarUrl || null]
        );
      }
      for (const row of dump.users || []) await client.query("INSERT INTO users (id, externalSubject, email, displayName, avatarUrl, role, isActive, createdAt, updatedAt, lastLoginAt) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)", [row.id, row.externalsubject || row.externalSubject, row.email, row.displayname || row.displayName, row.avatarurl || row.avatarUrl || null, row.role, row.isactive || row.isActive || 1, row.createdat || row.createdAt, row.updatedat || row.updatedAt, row.lastloginat || row.lastLoginAt]);
      for (const row of dump.user_secrets || []) await client.query("INSERT INTO user_secrets (id, userId, secretKey, ciphertext, iv, authTag, createdAt, updatedAt) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)", [row.id, row.userid || row.userId, row.secretkey || row.secretKey, row.ciphertext, row.iv, row.authtag || row.authTag, row.createdat || row.createdAt, row.updatedat || row.updatedAt]);
      for (const row of dump.app_config || []) await client.query("INSERT INTO app_config (id, key, scope, scopeId, valueJson, updatedAt, updatedBy) VALUES ($1,$2,$3,$4,$5,$6,$7)", [row.id, row.key, row.scope, row.scopeid || row.scopeId, row.valuejson || row.valueJson, row.updatedat || row.updatedAt, row.updatedby || row.updatedBy || null]);
      for (const row of dump.system_secrets || []) await client.query("INSERT INTO system_secrets (secretKey, ciphertext, iv, authTag, updatedAt, updatedBy) VALUES ($1,$2,$3,$4,$5,$6)", [row.secretkey || row.secretKey, row.ciphertext, row.iv, row.authtag || row.authTag, row.updatedat || row.updatedAt, row.updatedby || row.updatedBy || null]);
      for (const row of dump.packs || []) await client.query("INSERT INTO packs (id, language, type, topic, status, createdBy, createdAt, updatedAt) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)", [row.id, row.language, row.type, row.topic || null, row.status, row.createdby || row.createdBy || null, row.createdat || row.createdAt, row.updatedat || row.updatedAt]);
      for (const row of dump.pack_items || []) await client.query("INSERT INTO pack_items (id, packId, text, difficulty, metadataJson) VALUES ($1,$2,$3,$4,$5)", [row.id, row.packid || row.packId, row.text, row.difficulty || null, row.metadatajson || row.metadataJson || null]);
      for (const row of dump.auth_identities || []) await client.query("INSERT INTO auth_identities (id, userId, provider, providerSubject, passwordHash, createdAt, updatedAt) VALUES ($1,$2,$3,$4,$5,$6,$7)", [row.id, row.userid || row.userId, row.provider, row.providersubject || row.providerSubject || null, row.passwordhash || row.passwordHash || null, row.createdat || row.createdAt, row.updatedat || row.updatedAt]);
      for (const row of dump.password_resets || []) await client.query("INSERT INTO password_resets (id, userId, tokenHash, expiresAt, usedAt, createdAt, requestedIp) VALUES ($1,$2,$3,$4,$5,$6,$7)", [row.id, row.userid || row.userId, row.tokenhash || row.tokenHash, row.expiresat || row.expiresAt, row.usedat || row.usedAt || null, row.createdat || row.createdAt, row.requestedip || row.requestedIp || null]);
      for (const row of dump.crash_events || []) await client.query("INSERT INTO crash_events (id, occurredAt, appVersion, appBuild, appCommit, appMode, crashType, startupPhase, errorName, errorMessage, stackTrace, hostname, uptimeSeconds, metadataJson, acknowledgedAt, acknowledgedBy, resolved) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)", [row.id, row.occurredat || row.occurredAt, row.appversion || row.appVersion || null, row.appbuild || row.appBuild || null, row.appcommit || row.appCommit || null, row.appmode || row.appMode || null, row.crashtype || row.crashType, row.startupphase || row.startupPhase || null, row.errorname || row.errorName || null, row.errormessage || row.errorMessage || null, row.stacktrace || row.stackTrace || null, row.hostname || null, row.uptimeseconds || row.uptimeSeconds || null, row.metadatajson || row.metadataJson || null, row.acknowledgedat || row.acknowledgedAt || null, row.acknowledgedby || row.acknowledgedBy || null, row.resolved || 0]);

      await client.query("SELECT setval('leaderboard_id_seq', COALESCE((SELECT MAX(id) FROM leaderboard), 1), true)");
      await client.query("SELECT setval('vocab_packs_id_seq', COALESCE((SELECT MAX(id) FROM vocab_packs), 1), true)");
      await client.query("SELECT setval('users_id_seq', COALESCE((SELECT MAX(id) FROM users), 1), true)");
      await client.query("SELECT setval('user_secrets_id_seq', COALESCE((SELECT MAX(id) FROM user_secrets), 1), true)");
      await client.query("SELECT setval('app_config_id_seq', COALESCE((SELECT MAX(id) FROM app_config), 1), true)");
      await client.query("SELECT setval('packs_id_seq', COALESCE((SELECT MAX(id) FROM packs), 1), true)");
      await client.query("SELECT setval('pack_items_id_seq', COALESCE((SELECT MAX(id) FROM pack_items), 1), true)");
      await client.query("SELECT setval('auth_identities_id_seq', COALESCE((SELECT MAX(id) FROM auth_identities), 1), true)");
      await client.query("SELECT setval('password_resets_id_seq', COALESCE((SELECT MAX(id) FROM password_resets), 1), true)");
      await client.query("SELECT setval('crash_events_id_seq', COALESCE((SELECT MAX(id) FROM crash_events), 1), true)");
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  async counts() {
    const [settings, leaderboard, vocab_packs, users, app_config, packs, crashes] = await Promise.all([
      this.pool.query("SELECT COUNT(*)::int as c FROM settings"),
      this.pool.query("SELECT COUNT(*)::int as c FROM leaderboard"),
      this.pool.query("SELECT COUNT(*)::int as c FROM vocab_packs"),
      this.pool.query("SELECT COUNT(*)::int as c FROM users"),
      this.pool.query("SELECT COUNT(*)::int as c FROM app_config"),
      this.pool.query("SELECT COUNT(*)::int as c FROM packs"),
      this.pool.query("SELECT COUNT(*)::int as c FROM crash_events")
    ]);
    return { settings: settings.rows[0].c, leaderboard: leaderboard.rows[0].c, vocab_packs: vocab_packs.rows[0].c, users: users.rows[0].c, app_config: app_config.rows[0].c, packs: packs.rows[0].c, crashes: crashes.rows[0].c };
  }
}

module.exports = { PostgresAdapter };
