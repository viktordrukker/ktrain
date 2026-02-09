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
      (playerName, createdAt, contestType, level, contentMode, duration, taskTarget, score, accuracy, cpm, mistakes, tasksCompleted, timeSeconds, maxStreak)
      VALUES
      (@playerName, @createdAt, @contestType, @level, @contentMode, @duration, @taskTarget, @score, @accuracy, @cpm, @mistakes, @tasksCompleted, @timeSeconds, @maxStreak)
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
    return this.db.prepare(`SELECT * FROM leaderboard ${where} ORDER BY score DESC, accuracy DESC LIMIT 20`).all(...params);
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
    return this.db.prepare("SELECT * FROM users WHERE externalSubject = ? LIMIT 1").get(externalSubject) || null;
  }

  async findUserByEmail(email) {
    return this.db.prepare("SELECT * FROM users WHERE lower(email) = lower(?) LIMIT 1").get(email) || null;
  }

  async getOwnerUser() {
    return this.db.prepare("SELECT * FROM users WHERE role = 'OWNER' ORDER BY id ASC LIMIT 1").get() || null;
  }

  async createUser({ externalSubject, email, displayName, role }) {
    const now = nowIso();
    const result = this.db
      .prepare(
        "INSERT INTO users (externalSubject, email, displayName, role, isActive, createdAt, updatedAt, lastLoginAt) VALUES (?, ?, ?, ?, 1, ?, ?, ?)"
      )
      .run(externalSubject, email || null, displayName || null, role, now, now, now);
    return this.db.prepare("SELECT * FROM users WHERE id = ?").get(result.lastInsertRowid);
  }

  async listUsers() {
    return this.db.prepare("SELECT id, externalSubject, email, displayName, role, isActive, createdAt, updatedAt, lastLoginAt FROM users ORDER BY id ASC").all();
  }

  async updateUserRole(id, role) {
    this.db.prepare("UPDATE users SET role = ?, updatedAt = ? WHERE id = ?").run(role, nowIso(), id);
    return this.db.prepare("SELECT * FROM users WHERE id = ?").get(id) || null;
  }

  async touchUserLogin(id) {
    this.db.prepare("UPDATE users SET lastLoginAt = ?, updatedAt = ? WHERE id = ?").run(nowIso(), nowIso(), id);
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
      app_config: this.db.prepare("SELECT * FROM app_config ORDER BY id ASC").all()
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
        this.db.prepare("INSERT INTO users (id, externalSubject, email, displayName, role, isActive, createdAt, updatedAt, lastLoginAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
          .run(row.id, row.externalSubject || row.externalsubject, row.email, row.displayName || row.displayname, row.role, row.isActive || row.isactive || 1, row.createdAt || row.createdat, row.updatedAt || row.updatedat, row.lastLoginAt || row.lastloginat || null);
      }
      for (const row of dump.user_secrets || []) {
        this.db.prepare("INSERT INTO user_secrets (id, userId, secretKey, ciphertext, iv, authTag, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
          .run(row.id, row.userId || row.userid, row.secretKey || row.secretkey, row.ciphertext, row.iv, row.authTag || row.authtag, row.createdAt || row.createdat, row.updatedAt || row.updatedat);
      }
      for (const row of dump.app_config || []) {
        this.db.prepare("INSERT INTO app_config (id, key, scope, scopeId, valueJson, updatedAt, updatedBy) VALUES (?, ?, ?, ?, ?, ?, ?)")
          .run(row.id, row.key, row.scope, row.scopeId || row.scopeid, row.valueJson || row.valuejson, row.updatedAt || row.updatedat, row.updatedBy || row.updatedby || null);
      }

      this.db.prepare("DELETE FROM sqlite_sequence WHERE name IN ('leaderboard', 'vocab_packs', 'users', 'user_secrets', 'app_config', 'audit_log')").run();
    });
    tx();
  }

  async counts() {
    const settings = this.db.prepare("SELECT COUNT(*) as c FROM settings").get().c;
    const leaderboard = this.db.prepare("SELECT COUNT(*) as c FROM leaderboard").get().c;
    const vocab_packs = this.db.prepare("SELECT COUNT(*) as c FROM vocab_packs").get().c;
    const users = this.db.prepare("SELECT COUNT(*) as c FROM users").get().c;
    const app_config = this.db.prepare("SELECT COUNT(*) as c FROM app_config").get().c;
    return { settings, leaderboard, vocab_packs, users, app_config };
  }
}

module.exports = { SqliteAdapter };
