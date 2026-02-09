const fs = require("fs");
const path = require("path");

function migrationDir(driver) {
  return path.join(__dirname, "migrations", driver);
}

function loadMigrations(driver) {
  const dir = migrationDir(driver);
  const files = fs
    .readdirSync(dir)
    .filter((file) => /^\d+_.+\.sql$/.test(file) && !file.endsWith(".down.sql"))
    .sort();
  return files.map((file) => ({
    id: file,
    sql: fs.readFileSync(path.join(dir, file), "utf8")
  }));
}

function loadDownMigration(driver, id) {
  const downFile = id.replace(/\.sql$/, ".down.sql");
  const full = path.join(migrationDir(driver), downFile);
  if (!fs.existsSync(full)) return null;
  return fs.readFileSync(full, "utf8");
}

async function migrateUp(adapter, driver) {
  const migrations = loadMigrations(driver);
  const applied = await adapter.runMigrations(migrations);
  return { applied, total: migrations.length };
}

async function migrationStatus(adapter, driver) {
  const migrations = loadMigrations(driver);
  const appliedRows = await adapter.getAppliedMigrations();
  const appliedSet = new Set(appliedRows.map((row) => row.id));
  return {
    applied: appliedRows,
    pending: migrations.filter((m) => !appliedSet.has(m.id)).map((m) => m.id),
    total: migrations.length
  };
}

async function rollbackLast(adapter, driver) {
  const applied = await adapter.getAppliedMigrations();
  if (!applied.length) return { ok: false, error: "No migrations to rollback" };
  const last = applied[applied.length - 1];
  const downSql = loadDownMigration(driver, last.id);
  if (!downSql) {
    return { ok: false, error: `No down migration available for ${last.id}` };
  }
  await adapter.rollbackMigration(last.id, downSql);
  return { ok: true, rolledBack: last.id };
}

module.exports = {
  migrateUp,
  migrationStatus,
  rollbackLast,
  loadMigrations
};
