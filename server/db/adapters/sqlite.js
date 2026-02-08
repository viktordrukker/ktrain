const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

function ensureDir(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
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
    this.db.exec(this.migrationSql);
  }

  async close() {
    if (this.db) this.db.close();
  }

  async ping() {
    this.db.prepare("SELECT 1").get();
    return true;
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
      vocab_packs: this.db.prepare("SELECT * FROM vocab_packs ORDER BY id ASC").all()
    };
  }

  async restoreAll(dump) {
    const tx = this.db.transaction(() => {
      this.db.prepare("DELETE FROM leaderboard").run();
      this.db.prepare("DELETE FROM vocab_packs").run();
      this.db.prepare("DELETE FROM settings").run();

      for (const row of dump.settings || []) {
        this.db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run(row.key, row.value);
      }
      for (const row of dump.vocab_packs || []) {
        this.db.prepare("INSERT INTO vocab_packs (id, name, packType, items, active, createdAt) VALUES (?, ?, ?, ?, ?, ?)")
          .run(row.id, row.name, row.packType, row.items, row.active, row.createdAt);
      }
      for (const row of dump.leaderboard || []) {
        this.db.prepare("INSERT INTO leaderboard (id, playerName, createdAt, contestType, level, contentMode, duration, taskTarget, score, accuracy, cpm, mistakes, tasksCompleted, timeSeconds, maxStreak) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
          .run(row.id, row.playerName, row.createdAt, row.contestType, row.level, row.contentMode, row.duration, row.taskTarget, row.score, row.accuracy, row.cpm, row.mistakes, row.tasksCompleted, row.timeSeconds, row.maxStreak);
      }
      this.db.prepare("DELETE FROM sqlite_sequence WHERE name IN ('leaderboard', 'vocab_packs')").run();
    });
    tx();
  }

  async counts() {
    const settings = this.db.prepare("SELECT COUNT(*) as c FROM settings").get().c;
    const leaderboard = this.db.prepare("SELECT COUNT(*) as c FROM leaderboard").get().c;
    const vocab_packs = this.db.prepare("SELECT COUNT(*) as c FROM vocab_packs").get().c;
    return { settings, leaderboard, vocab_packs };
  }
}

module.exports = { SqliteAdapter };
