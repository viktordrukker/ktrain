const fs = require("fs");
const path = require("path");
const { SqliteAdapter } = require("./adapters/sqlite");
const { PostgresAdapter } = require("./adapters/postgres");
const { readRuntimeConfig } = require("./runtime-config");

const DB_DRIVER_ENV = process.env.DB_DRIVER || "sqlite";
const SQLITE_PATH = process.env.SQLITE_PATH || process.env.DB_PATH || "/data/ktrain.sqlite";

const POSTGRES = {
  host: process.env.POSTGRES_HOST || "ktrain_postgres",
  port: Number(process.env.POSTGRES_PORT || 5432),
  database: process.env.POSTGRES_DB || "ktrain",
  user: process.env.POSTGRES_USER || "ktrain",
  password: process.env.POSTGRES_PASSWORD || "ktrain"
};

function loadMigrationSql(driver) {
  const file = path.join(__dirname, "migrations", driver, "001_init.sql");
  return fs.readFileSync(file, "utf8");
}

function resolveDriver() {
  const runtime = readRuntimeConfig();
  return runtime.activeDriver || DB_DRIVER_ENV;
}

async function createAdapter(driver) {
  if (driver === "postgres") {
    const adapter = new PostgresAdapter({ migrationSql: loadMigrationSql("postgres"), postgres: POSTGRES });
    await adapter.init();
    return adapter;
  }
  const adapter = new SqliteAdapter({ sqlitePath: SQLITE_PATH, migrationSql: loadMigrationSql("sqlite") });
  await adapter.init();
  return adapter;
}

async function initDb() {
  const driver = resolveDriver();
  const adapter = await createAdapter(driver);
  return { adapter, driver };
}

module.exports = {
  DB_DRIVER_ENV,
  SQLITE_PATH,
  POSTGRES,
  resolveDriver,
  createAdapter,
  initDb
};
