const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");
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

function summarizeConnectionString(connectionString = "") {
  const raw = String(connectionString || "").trim();
  if (!raw) return "";
  try {
    const url = new URL(raw);
    const userPart = url.username ? `${url.username}@` : "";
    return `${url.protocol}//${userPart}${url.hostname}${url.port ? `:${url.port}` : ""}${url.pathname || ""}`;
  } catch {
    return "[invalid_connection_string]";
  }
}

function sanitizeDbConfigForStatus(input = {}) {
  const cfg = sanitizeDbConfig(input);
  return {
    sqlitePath: cfg.sqlitePath,
    postgres: {
      host: cfg.postgres.host,
      port: cfg.postgres.port,
      database: cfg.postgres.database,
      user: cfg.postgres.user,
      hasPassword: Boolean(String(cfg.postgres.password || "")),
      hasConnectionString: Boolean(String(cfg.postgres.connectionString || "")),
      connectionStringSummary: summarizeConnectionString(cfg.postgres.connectionString || "")
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
  return resolveDbConfigMeta().config;
}

function resolveDbConfigMeta() {
  const runtime = readRuntimeConfig();
  if (runtime.dbConfig) {
    return {
      source: "runtime",
      config: sanitizeDbConfig(runtime.dbConfig || {})
    };
  }
  const bootstrap = parseBootstrapDb(KTRAIN_BOOTSTRAP_DB);
  if (bootstrap?.dbConfig) {
    return {
      source: "bootstrap",
      config: bootstrap.dbConfig
    };
  }
  return {
    source: "env",
    config: sanitizeDbConfig({})
  };
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

function toSafePostgresError(err) {
  const raw = String(err?.message || "Postgres connection failed");
  if (/password authentication failed/i.test(raw)) {
    return "Postgres authentication failed. Check username/password.";
  }
  if (/no pg_hba\.conf entry/i.test(raw)) {
    return "Postgres rejected this host/user combination (pg_hba.conf).";
  }
  if (/getaddrinfo|ENOTFOUND|EAI_AGAIN/i.test(raw)) {
    return "Postgres host could not be resolved.";
  }
  if (/ECONNREFUSED/i.test(raw)) {
    return "Postgres is unreachable (connection refused).";
  }
  if (/timeout/i.test(raw)) {
    return "Postgres connection timed out.";
  }
  return raw;
}

function classifyDbError(err) {
  const code = String(err?.code || "").toUpperCase();
  const message = String(err?.message || "");
  if (
    ["42P07", "42701", "42710", "42P16"].includes(code) ||
    /relation .* already exists/i.test(message) ||
    /column .* already exists/i.test(message)
  ) return "schema_conflict";
  if (
    ["42P01", "42703"].includes(code) ||
    /relation .* does not exist/i.test(message) ||
    /column .* does not exist/i.test(message)
  ) return "schema_mismatch";
  if (code === "28P01" || /password authentication failed/i.test(message)) return "auth";
  if (code === "3D000" || /database .* does not exist/i.test(message)) return "database_not_found";
  if (code === "28000") return "access_denied";
  if (/no pg_hba\.conf entry/i.test(message)) return "pg_hba";
  if (/EAI_AGAIN|ENOTFOUND|getaddrinfo/i.test(message)) return "dns";
  if (/ECONNREFUSED/i.test(message)) return "network_refused";
  if (/ETIMEDOUT|timeout/i.test(message)) return "network_timeout";
  if (/self signed certificate|certificate/i.test(message)) return "tls";
  return "unknown";
}

function dbErrorHint(category) {
  switch (category) {
    case "schema_conflict":
      return "Database schema differs from expected migration state. Use existing DB mode or reinitialize schema before copy.";
    case "schema_mismatch":
      return "Schema is incomplete or outdated. Run migrations/re-init for the selected database.";
    case "auth":
      return "Verify Postgres username/password and authentication method.";
    case "database_not_found":
      return "Verify the database name exists and the user can access it.";
    case "access_denied":
      return "Verify DB role permissions and host-based access rules.";
    case "pg_hba":
      return "Update pg_hba.conf or server access rules for this host/user.";
    case "dns":
      return "Check hostname resolution from container network and Docker DNS.";
    case "network_refused":
      return "Check Postgres host/port and that the service is reachable.";
    case "network_timeout":
      return "Check network routing/firewall and Postgres availability.";
    case "tls":
      return "Check TLS/SSL settings between app and Postgres.";
    default:
      return "Check server logs and DB configuration.";
  }
}

function buildDbErrorDiagnostics(err) {
  const category = classifyDbError(err);
  return {
    message: toSafePostgresError(err),
    code: err?.code || null,
    category,
    hint: dbErrorHint(category),
    retryable: ["dns", "network_refused", "network_timeout"].includes(category),
    severity: err?.severity || null,
    routine: err?.routine || null
  };
}

async function testPostgresConfig(inputConfig = {}) {
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
  const pool = new Pool({
    max: 1,
    idleTimeoutMillis: Number(process.env.POSTGRES_IDLE_TIMEOUT_MS || 30000),
    connectionTimeoutMillis: Number(process.env.POSTGRES_CONNECT_TIMEOUT_MS || 10000),
    ...pgConfig
  });
  try {
    await pool.query("SELECT 1");
    return true;
  } catch (err) {
    const diagnostics = buildDbErrorDiagnostics(err);
    const wrapped = new Error(diagnostics.message);
    wrapped.status = 400;
    wrapped.code = String(diagnostics.code || "POSTGRES_TEST_FAILED");
    wrapped.expose = true;
    wrapped.details = diagnostics;
    wrapped.cause = err;
    throw wrapped;
  } finally {
    await pool.end().catch(() => null);
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
  sanitizeDbConfigForStatus,
  resolveDbConfig,
  resolveDbConfigMeta,
  buildDbErrorDiagnostics,
  testPostgresConfig,
  resolveDriver,
  createAdapter,
  initDb,
  getMigrationStatus,
  rollbackLastMigration
};
