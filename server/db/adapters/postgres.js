const { Pool } = require("pg");

function nowIso() {
  return new Date().toISOString();
}

function mapUserRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    externalSubject: row.externalsubject,
    email: row.email,
    displayName: row.displayname,
    role: row.role,
    isActive: row.isactive,
    createdAt: row.createdat,
    updatedAt: row.updatedat,
    lastLoginAt: row.lastloginat
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
    if (this.migrationSql) {
      await this.pool.query(this.migrationSql);
    }
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
      (playerName, createdAt, contestType, level, contentMode, duration, taskTarget, score, accuracy, cpm, mistakes, tasksCompleted, timeSeconds, maxStreak)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
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
        payload.maxStreak
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
    const { rows } = await this.pool.query(`SELECT * FROM leaderboard ${where} ORDER BY score DESC, accuracy DESC LIMIT 20`, params);
    return rows;
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

  async getOwnerUser() {
    const { rows } = await this.pool.query("SELECT * FROM users WHERE role = 'OWNER' ORDER BY id ASC LIMIT 1");
    return mapUserRow(rows[0]);
  }

  async createUser({ externalSubject, email, displayName, role }) {
    const now = nowIso();
    const { rows } = await this.pool.query(
      `INSERT INTO users (externalSubject, email, displayName, role, isActive, createdAt, updatedAt, lastLoginAt)
       VALUES ($1, $2, $3, $4, 1, $5, $5, $5)
       RETURNING *`,
      [externalSubject, email || null, displayName || null, role, now]
    );
    return mapUserRow(rows[0]);
  }

  async listUsers() {
    const { rows } = await this.pool.query("SELECT id, externalSubject, email, displayName, role, isActive, createdAt, updatedAt, lastLoginAt FROM users ORDER BY id ASC");
    return rows.map(mapUserRow);
  }

  async updateUserRole(id, role) {
    const { rows } = await this.pool.query("UPDATE users SET role = $1, updatedAt = $2 WHERE id = $3 RETURNING *", [role, nowIso(), id]);
    return mapUserRow(rows[0]);
  }

  async touchUserLogin(id) {
    await this.pool.query("UPDATE users SET lastLoginAt = $1, updatedAt = $1 WHERE id = $2", [nowIso(), id]);
  }

  async getUserSecret(userId, secretKey) {
    const { rows } = await this.pool.query(
      "SELECT * FROM user_secrets WHERE userId = $1 AND secretKey = $2 LIMIT 1",
      [userId, secretKey]
    );
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
    const { rows } = await this.pool.query(
      "SELECT * FROM app_config WHERE key = $1 AND scope = $2 AND scopeId = $3 LIMIT 1",
      [key, scope, scopeId]
    );
    if (!rows[0]) return null;
    return {
      ...rows[0],
      valueJson: JSON.parse(rows[0].valuejson || rows[0].valueJson)
    };
  }

  async listConfig(scope, scopeId) {
    const { rows } = await this.pool.query(
      "SELECT * FROM app_config WHERE scope = $1 AND scopeId = $2 ORDER BY key ASC",
      [scope, scopeId]
    );
    return rows.map((row) => ({
      ...row,
      scopeId: row.scopeid,
      valueJson: JSON.parse(row.valuejson)
    }));
  }

  async insertAuditLog(payload) {
    await this.pool.query(
      `INSERT INTO audit_log (actorUserId, actorRole, action, targetType, targetId, metadata, requestId, ip, createdAt)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        payload.actorUserId || null,
        payload.actorRole || null,
        payload.action,
        payload.targetType || null,
        payload.targetId || null,
        payload.metadata ? JSON.stringify(payload.metadata) : null,
        payload.requestId || null,
        payload.ip || null,
        payload.createdAt || nowIso()
      ]
    );
  }

  async listAuditLogs(limit = 100) {
    const { rows } = await this.pool.query("SELECT * FROM audit_log ORDER BY id DESC LIMIT $1", [Number(limit)]);
    return rows.map((row) => ({
      ...row,
      actorUserId: row.actoruserid,
      actorRole: row.actorrole,
      targetType: row.targettype,
      targetId: row.targetid,
      requestId: row.requestid,
      createdAt: row.createdat,
      metadata: row.metadata ? JSON.parse(row.metadata) : null
    }));
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
    const [settings, leaderboard, vocab_packs, users, user_secrets, app_config] = await Promise.all([
      this.pool.query("SELECT key, value FROM settings ORDER BY key ASC"),
      this.pool.query("SELECT * FROM leaderboard ORDER BY id ASC"),
      this.pool.query("SELECT * FROM vocab_packs ORDER BY id ASC"),
      this.pool.query("SELECT * FROM users ORDER BY id ASC"),
      this.pool.query("SELECT * FROM user_secrets ORDER BY id ASC"),
      this.pool.query("SELECT * FROM app_config ORDER BY id ASC")
    ]);
    return {
      settings: settings.rows,
      leaderboard: leaderboard.rows,
      vocab_packs: vocab_packs.rows,
      users: users.rows,
      user_secrets: user_secrets.rows,
      app_config: app_config.rows
    };
  }

  async restoreAll(dump) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("TRUNCATE TABLE leaderboard, vocab_packs, settings, user_secrets, users, app_config RESTART IDENTITY CASCADE");
      for (const row of dump.settings || []) {
        await client.query("INSERT INTO settings (key, value) VALUES ($1, $2)", [row.key, row.value]);
      }
      for (const row of dump.vocab_packs || []) {
        await client.query(
          "INSERT INTO vocab_packs (id, name, packType, items, active, createdAt) VALUES ($1, $2, $3, $4, $5, $6)",
          [row.id, row.name, row.packType || row.packtype, row.items, row.active, row.createdat || row.createdAt]
        );
      }
      for (const row of dump.leaderboard || []) {
        await client.query(
          "INSERT INTO leaderboard (id, playerName, createdAt, contestType, level, contentMode, duration, taskTarget, score, accuracy, cpm, mistakes, tasksCompleted, timeSeconds, maxStreak) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)",
          [
            row.id,
            row.playername || row.playerName,
            row.createdat || row.createdAt,
            row.contesttype || row.contestType,
            row.level,
            row.contentmode || row.contentMode,
            row.duration,
            row.tasktarget || row.taskTarget,
            row.score,
            row.accuracy,
            row.cpm,
            row.mistakes,
            row.taskscompleted || row.tasksCompleted,
            row.timeseconds || row.timeSeconds,
            row.maxstreak || row.maxStreak
          ]
        );
      }
      for (const row of dump.users || []) {
        await client.query(
          "INSERT INTO users (id, externalSubject, email, displayName, role, isActive, createdAt, updatedAt, lastLoginAt) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
          [
            row.id,
            row.externalsubject || row.externalSubject,
            row.email,
            row.displayname || row.displayName,
            row.role,
            row.isactive || row.isActive || 1,
            row.createdat || row.createdAt,
            row.updatedat || row.updatedAt,
            row.lastloginat || row.lastLoginAt
          ]
        );
      }
      for (const row of dump.user_secrets || []) {
        await client.query(
          "INSERT INTO user_secrets (id, userId, secretKey, ciphertext, iv, authTag, createdAt, updatedAt) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
          [
            row.id,
            row.userid || row.userId,
            row.secretkey || row.secretKey,
            row.ciphertext,
            row.iv,
            row.authtag || row.authTag,
            row.createdat || row.createdAt,
            row.updatedat || row.updatedAt
          ]
        );
      }
      for (const row of dump.app_config || []) {
        await client.query(
          "INSERT INTO app_config (id, key, scope, scopeId, valueJson, updatedAt, updatedBy) VALUES ($1,$2,$3,$4,$5,$6,$7)",
          [
            row.id,
            row.key,
            row.scope,
            row.scopeid || row.scopeId,
            row.valuejson || row.valueJson,
            row.updatedat || row.updatedAt,
            row.updatedby || row.updatedBy || null
          ]
        );
      }

      await client.query("SELECT setval('leaderboard_id_seq', COALESCE((SELECT MAX(id) FROM leaderboard), 1), true)");
      await client.query("SELECT setval('vocab_packs_id_seq', COALESCE((SELECT MAX(id) FROM vocab_packs), 1), true)");
      await client.query("SELECT setval('users_id_seq', COALESCE((SELECT MAX(id) FROM users), 1), true)");
      await client.query("SELECT setval('user_secrets_id_seq', COALESCE((SELECT MAX(id) FROM user_secrets), 1), true)");
      await client.query("SELECT setval('app_config_id_seq', COALESCE((SELECT MAX(id) FROM app_config), 1), true)");
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  async counts() {
    const [settings, leaderboard, vocab_packs, users, app_config] = await Promise.all([
      this.pool.query("SELECT COUNT(*)::int as c FROM settings"),
      this.pool.query("SELECT COUNT(*)::int as c FROM leaderboard"),
      this.pool.query("SELECT COUNT(*)::int as c FROM vocab_packs"),
      this.pool.query("SELECT COUNT(*)::int as c FROM users"),
      this.pool.query("SELECT COUNT(*)::int as c FROM app_config")
    ]);
    return {
      settings: settings.rows[0].c,
      leaderboard: leaderboard.rows[0].c,
      vocab_packs: vocab_packs.rows[0].c,
      users: users.rows[0].c,
      app_config: app_config.rows[0].c
    };
  }
}

module.exports = { PostgresAdapter };
