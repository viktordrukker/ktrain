const fs = require("fs");
const path = require("path");
const { SqliteAdapter } = require("./adapters/sqlite");
const { PostgresAdapter } = require("./adapters/postgres");
const { readRuntimeConfig } = require("./runtime-config");
const { migrateUp, migrationStatus, rollbackLast } = require("./migration-runner");

const KTRAIN_BOOTSTRAP_DB = process.env.KTRAIN_BOOTSTRAP_DB || "";
const DB_DRIVER_ENV = process.env.DB_DRIVER || "sqlite";
const SQLITE_PATH = process.env.SQLITE_PATH || process.env.DB_PATH || "/data/ktrain.sqlite";

const POSTGRES = {
  host: process.env.POSTGRES_HOST || "ktrain_postgres",
  port: Number(process.env.POSTGRES_PORT || 5432),
  database: process.env.POSTGRES_DB || "ktrain",
  user: process.env.POSTGRES_USER || "ktrain",
  password: process.env.POSTGRES_PASSWORD || "ktrain"
};

function sanitizeDbConfig(input = {}) {
  const postgresInput = input.postgres || {};
  return {
    sqlitePath: String(input.sqlitePath || SQLITE_PATH),
    postgres: {
      host: String(postgresInput.host || POSTGRES.host),
      port: Number(postgresInput.port || POSTGRES.port),
      database: String(postgresInput.database || POSTGRES.database),
      user: String(postgresInput.user || POSTGRES.user),
      password: String(postgresInput.password || POSTGRES.password),
      connectionString: postgresInput.connectionString ? String(postgresInput.connectionString) : ""
    }
  };
}

function parseBootstrapDb(input = "") {
  const raw = String(input || "").trim();
  if (!raw) return null;
  if (raw.startsWith("postgres://") || raw.startsWith("postgresql://")) {
    return {
      activeDriver: "postgres",
      dbConfig: sanitizeDbConfig({ postgres: { connectionString: raw } })
    };
  }
  if (raw.startsWith("sqlite:")) {
    return {
      activeDriver: "sqlite",
      dbConfig: sanitizeDbConfig({ sqlitePath: raw.replace(/^sqlite:/, "") })
    };
  }
  return {
    activeDriver: "sqlite",
    dbConfig: sanitizeDbConfig({ sqlitePath: raw })
  };
}

function resolveDbConfig() {
  const runtime = readRuntimeConfig();
  if (runtime.dbConfig) return sanitizeDbConfig(runtime.dbConfig || {});
  const bootstrap = parseBootstrapDb(KTRAIN_BOOTSTRAP_DB);
  if (bootstrap?.dbConfig) return bootstrap.dbConfig;
  return sanitizeDbConfig({});
}

function loadMigrationSql(driver) {
  const file = path.join(__dirname, "migrations", driver, "001_init.sql");
  return fs.readFileSync(file, "utf8");
}

function resolveDriver() {
  const runtime = readRuntimeConfig();
  const bootstrap = parseBootstrapDb(KTRAIN_BOOTSTRAP_DB);
  if (!runtime.activeDriver && bootstrap?.activeDriver) return bootstrap.activeDriver;
  return runtime.activeDriver || DB_DRIVER_ENV;
}

async function createAdapter(driver) {
  const config = resolveDbConfig();
  if (driver === "postgres") {
    const adapter = new PostgresAdapter({
      migrationSql: loadMigrationSql("postgres"),
      postgres: config.postgres.connectionString
        ? { connectionString: config.postgres.connectionString }
        : {
            host: config.postgres.host,
            port: config.postgres.port,
            database: config.postgres.database,
            user: config.postgres.user,
            password: config.postgres.password
          }
    });
    await adapter.init();
    await migrateUp(adapter, "postgres");
    return adapter;
  }
  const adapter = new SqliteAdapter({ sqlitePath: config.sqlitePath, migrationSql: loadMigrationSql("sqlite") });
  await adapter.init();
  await migrateUp(adapter, "sqlite");
  return adapter;
}

async function createPostgresAdapterForConfig(inputConfig = {}) {
  const safe = sanitizeDbConfig({ postgres: inputConfig }).postgres;
  const pgConfig = safe.connectionString
    ? { connectionString: safe.connectionString }
    : {
        host: safe.host,
        port: safe.port,
        database: safe.database,
        user: safe.user,
        password: safe.password
      };
  const adapter = new PostgresAdapter({ migrationSql: loadMigrationSql("postgres"), postgres: pgConfig });
  await adapter.init();
  await migrateUp(adapter, "postgres");
  return adapter;
}

async function testPostgresConfig(inputConfig = {}) {
  const adapter = await createPostgresAdapterForConfig(inputConfig);
  try {
    await adapter.ping();
    return true;
  } finally {
    await adapter.close();
  }
}

async function initDb() {
  const driver = resolveDriver();
  const adapter = await createAdapter(driver);
  return { adapter, driver };
}

async function getMigrationStatus(adapter, driver) {
  return migrationStatus(adapter, driver);
}

async function rollbackLastMigration(adapter, driver) {
  return rollbackLast(adapter, driver);
}

module.exports = {
  DB_DRIVER_ENV,
  SQLITE_PATH,
  POSTGRES,
  sanitizeDbConfig,
  resolveDbConfig,
  testPostgresConfig,
  resolveDriver,
  createAdapter,
  initDb,
  getMigrationStatus,
  rollbackLastMigration
};
