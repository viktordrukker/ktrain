const { Pool } = require("pg");

class PostgresAdapter {
  constructor({ migrationSql, postgres }) {
    this.driver = "postgres";
    this.migrationSql = migrationSql;
    this.pool = new Pool(postgres);
  }

  async init() {
    await this.pool.query(this.migrationSql);
  }

  async close() {
    await this.pool.end();
  }

  async ping() {
    await this.pool.query("SELECT 1");
    return true;
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
    const [settings, leaderboard, vocab_packs] = await Promise.all([
      this.pool.query("SELECT key, value FROM settings ORDER BY key ASC"),
      this.pool.query("SELECT * FROM leaderboard ORDER BY id ASC"),
      this.pool.query("SELECT * FROM vocab_packs ORDER BY id ASC")
    ]);
    return {
      settings: settings.rows,
      leaderboard: leaderboard.rows,
      vocab_packs: vocab_packs.rows
    };
  }

  async restoreAll(dump) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("TRUNCATE TABLE leaderboard, vocab_packs, settings RESTART IDENTITY");
      for (const row of dump.settings || []) {
        await client.query("INSERT INTO settings (key, value) VALUES ($1, $2)", [row.key, row.value]);
      }
      for (const row of dump.vocab_packs || []) {
        await client.query(
          "INSERT INTO vocab_packs (id, name, packType, items, active, createdAt) VALUES ($1, $2, $3, $4, $5, $6)",
          [row.id, row.name, row.packType, row.items, row.active, row.createdat || row.createdAt]
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
      await client.query("SELECT setval('leaderboard_id_seq', COALESCE((SELECT MAX(id) FROM leaderboard), 1), true)");
      await client.query("SELECT setval('vocab_packs_id_seq', COALESCE((SELECT MAX(id) FROM vocab_packs), 1), true)");
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  async counts() {
    const settings = await this.pool.query("SELECT COUNT(*)::int as c FROM settings");
    const leaderboard = await this.pool.query("SELECT COUNT(*)::int as c FROM leaderboard");
    const vocab_packs = await this.pool.query("SELECT COUNT(*)::int as c FROM vocab_packs");
    return {
      settings: settings.rows[0].c,
      leaderboard: leaderboard.rows[0].c,
      vocab_packs: vocab_packs.rows[0].c
    };
  }
}

module.exports = { PostgresAdapter };
