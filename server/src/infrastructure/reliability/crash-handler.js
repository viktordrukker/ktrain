const fs = require("fs");
const os = require("os");
const path = require("path");
const express = require("express");
const { Pool } = require("pg");
const { readRuntimeConfig, writeRuntimeConfig, RUNTIME_CONFIG_PATH } = require("../../../db/runtime-config");

function nowIso() {
  return new Date().toISOString();
}

function redactValue(key, value) {
  const secretLike = /(password|secret|token|authorization|cookie|key|credential)/i;
  if (secretLike.test(String(key || ""))) return "[REDACTED]";
  if (typeof value === "string") {
    let out = value;
    out = out.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "***@***");
    out = out.replace(/(bearer\s+)[a-z0-9._\-]+/gi, "$1[REDACTED]");
    out = out.replace(/(token=)[^&\s]+/gi, "$1[REDACTED]");
    return out;
  }
  return value;
}

function deepRedact(value, key = "") {
  if (Array.isArray(value)) return value.map((item) => deepRedact(item, key));
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = deepRedact(redactValue(k, v), k);
    }
    return out;
  }
  return redactValue(key, value);
}

function sanitizeError(err) {
  const name = err?.name ? String(err.name) : "Error";
  const message = err?.message ? String(err.message) : String(err || "Unknown error");
  const stack = err?.stack ? String(err.stack) : "";
  return {
    name: redactValue("error_name", name),
    message: redactValue("error_message", message),
    stack: redactValue("error_stack", stack)
  };
}

function safeJsonStringify(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return JSON.stringify({ error: "serialization_failed" });
  }
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function parseDriver(raw, fallback = "sqlite") {
  const value = String(raw || "").toLowerCase();
  return value === "postgres" ? "postgres" : (value === "sqlite" ? "sqlite" : fallback);
}

function readRecentCrashFiles(crashDir, limit = 3) {
  try {
    if (!fs.existsSync(crashDir)) return [];
    const files = fs.readdirSync(crashDir)
      .filter((f) => f.endsWith(".json"))
      .sort((a, b) => a.localeCompare(b))
      .slice(-limit);
    return files.map((file) => path.join(crashDir, file));
  } catch {
    return [];
  }
}

async function probePostgres(input) {
  const cfg = input.connectionString
    ? { connectionString: input.connectionString }
    : {
        host: input.host,
        port: Number(input.port || 5432),
        database: input.database,
        user: input.user,
        password: input.password || ""
      };
  const pool = new Pool({
    max: 1,
    connectionTimeoutMillis: Number(process.env.POSTGRES_CONNECT_TIMEOUT_MS || 10000),
    idleTimeoutMillis: Number(process.env.POSTGRES_IDLE_TIMEOUT_MS || 30000),
    ...cfg
  });
  try {
    await pool.query("SELECT 1");
    return { ok: true };
  } finally {
    await pool.end().catch(() => null);
  }
}

class CrashHandler {
  constructor(options = {}) {
    this.getRepo = options.getRepo || (() => null);
    this.getSmtpService = options.getSmtpService || (() => null);
    this.getBuildInfo = options.getBuildInfo || (() => ({}));
    this.getStartupPhase = options.getStartupPhase || (() => "unknown");
    this.getAppMode = options.getAppMode || (() => "info");
    this.getAdminEmails = options.getAdminEmails || (() => []);
    this.crashDir = options.crashDir || "/data/crash-reports";
    this.recoveryPort = options.recoveryPort || Number(process.env.PORT || 3000);
    this.recoveryServer = null;
    this.lastCrashReport = null;
  }

  buildReport({ type, error, metadata }) {
    const e = sanitizeError(error);
    const build = this.getBuildInfo();
    return deepRedact({
      occurredAt: nowIso(),
      appVersion: build.version || "0.0.0",
      appBuild: build.build || "0",
      appCommit: build.commit || "unknown",
      appMode: this.getAppMode(),
      crashType: type,
      startupPhase: this.getStartupPhase(),
      errorName: e.name,
      errorMessage: e.message,
      stackTrace: e.stack,
      hostname: os.hostname(),
      uptimeSeconds: Number(process.uptime().toFixed(3)),
      metadataJson: metadata || {}
    });
  }

  persistToFs(report) {
    try {
      if (!fs.existsSync(this.crashDir)) fs.mkdirSync(this.crashDir, { recursive: true });
      const file = path.join(this.crashDir, `${Date.now()}-${report.crashType || "crash"}.json`);
      fs.writeFileSync(file, `${safeJsonStringify(report)}\n`, "utf8");
      return file;
    } catch {
      return null;
    }
  }

  async persist(report) {
    let dbSaved = false;
    try {
      const repo = this.getRepo();
      if (repo?.insertCrashEvent) {
        await repo.insertCrashEvent(report);
        dbSaved = true;
      }
    } catch {
      dbSaved = false;
    }
    const file = this.persistToFs(report);
    return { dbSaved, file };
  }

  async notify(report, persisted) {
    const smtp = this.getSmtpService();
    const recipients = this.getAdminEmails().filter(Boolean);
    if (!smtp || recipients.length === 0) return false;
    try {
      const subject = `[K-TRAIN CRASH] ${process.env.NODE_ENV || "env"} ${report.appVersion}`;
      const summary = [
        `Crash time: ${report.occurredAt}`,
        `Version: ${report.appVersion} build ${report.appBuild} (${report.appCommit})`,
        `Type: ${report.crashType}`,
        `Reason: ${report.errorName}: ${report.errorMessage}`,
        `Phase: ${report.startupPhase}`,
        persisted?.file ? `Report file: ${persisted.file}` : "Report file: unavailable"
      ].join("\n");
      await smtp.send({
        to: recipients.join(","),
        subject,
        text: summary,
        html: `<pre>${summary.replace(/</g, "&lt;")}</pre>`
      });
      return true;
    } catch {
      return false;
    }
  }

  async capture({ type, error, metadata }) {
    const report = this.buildReport({ type, error, metadata });
    this.lastCrashReport = report;
    const persisted = await this.persist(report);
    // SECURITY: structured crash log is redacted before output.
    console.error(`CRASH_EVENT ${safeJsonStringify({ report, persisted })}`);
    await this.notify(report, persisted);
    return { report, persisted };
  }

  startRecoveryServer() {
    if (this.recoveryServer) return;
    const app = express();
    app.use(express.urlencoded({ extended: false }));
    app.use(express.json({ limit: "256kb" }));

    const getSummary = () => this.lastCrashReport || {
      occurredAt: nowIso(),
      errorMessage: "Unknown startup failure",
      appMode: this.getAppMode()
    };

    const getRuntimeState = () => {
      const runtime = readRuntimeConfig();
      const runtimePostgres = runtime?.dbConfig?.postgres || {};
      return {
        activeDriver: parseDriver(runtime?.activeDriver || process.env.DB_DRIVER || "sqlite", "sqlite"),
        sqlitePath: String(runtime?.dbConfig?.sqlitePath || process.env.SQLITE_PATH || "/data/ktrain.sqlite"),
        postgres: {
          host: String(runtimePostgres.host || process.env.POSTGRES_HOST || "ff_postgres"),
          port: Number(runtimePostgres.port || process.env.POSTGRES_PORT || 5432),
          database: String(runtimePostgres.database || process.env.POSTGRES_DB || "ktrain"),
          user: String(runtimePostgres.user || process.env.POSTGRES_USER || "ktrain"),
          // SECURITY: never prefill secrets to the HTML recovery page.
          password: "",
          connectionString: String(runtimePostgres.connectionString || "")
        }
      };
    };

    const parseIncomingPostgres = (body = {}, existing = {}) => {
      const incomingConnectionString = String(body.connectionString || "").trim();
      if (incomingConnectionString) {
        return {
          connectionString: incomingConnectionString
        };
      }
      const host = String(body.host || existing.host || "").trim();
      const port = Number(body.port || existing.port || 5432);
      const database = String(body.database || existing.database || "").trim();
      const user = String(body.user || existing.user || "").trim();
      const incomingPassword = String(body.password || "").trim();
      const password = incomingPassword || String(existing.password || "").trim();
      if (!host || !database || !user || !password) {
        const err = new Error("Postgres host/database/user/password are required unless connection string is provided.");
        err.status = 400;
        throw err;
      }
      return { host, port, database, user, password, connectionString: "" };
    };

    const renderRecoveryHtml = ({ message = "", error = "", detail = "", preferredDriver = null } = {}) => {
      const report = getSummary();
      const mode = String(this.getAppMode() || "info");
      const state = getRuntimeState();
      const selectedDriver = parseDriver(preferredDriver || state.activeDriver, state.activeDriver);
      const recentFiles = readRecentCrashFiles(this.crashDir, 3);
      const stackVisible = Boolean(report.stackTrace);
      const showStack = mode === "advanced-debug" || mode === "debug" || stackVisible;
      const reportJson = safeJsonStringify(report);
      const detailText = detail || "";

      const flash = message
        ? `<p style="padding:10px 12px;border-radius:8px;background:#123a21;color:#c9ffd9;border:1px solid #2f6f43">${escapeHtml(message)}</p>`
        : "";
      const errorBox = error
        ? `<p style="padding:10px 12px;border-radius:8px;background:#3a1717;color:#ffd6d6;border:1px solid #7f3131">${escapeHtml(error)}</p>`
        : "";

      return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>KTrain Recovery Mode</title>
  <style>
    :root { color-scheme: dark; }
    body { margin: 0; font-family: Arial, sans-serif; background: #0f1115; color: #e8eef8; }
    .wrap { max-width: 980px; margin: 0 auto; padding: 24px; }
    .card { background: #171c23; border: 1px solid #2a3240; border-radius: 12px; padding: 16px; margin-bottom: 16px; }
    h1, h2, h3 { margin: 0 0 12px; }
    p { margin: 0 0 10px; line-height: 1.45; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
    .grid-1 { display: grid; grid-template-columns: 1fr; gap: 10px; }
    label { font-size: 13px; color: #aab6ca; display: block; margin-bottom: 4px; }
    input, select, textarea, button { font: inherit; }
    input, select, textarea {
      width: 100%; box-sizing: border-box; padding: 9px 10px;
      border-radius: 8px; border: 1px solid #39475c; background: #0f141c; color: #e8eef8;
    }
    textarea { min-height: 74px; }
    button {
      padding: 10px 14px; border-radius: 8px; border: 1px solid #3d6db6;
      background: #1f5fb4; color: #fff; cursor: pointer;
    }
    button.secondary { background: #243042; border-color: #4b617f; }
    .muted { color: #95a3bb; font-size: 12px; }
    pre {
      white-space: pre-wrap; background: #0d1219; border: 1px solid #2b3646;
      border-radius: 8px; padding: 12px; overflow: auto;
    }
    .row { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="card">
      <h1>Application is in recovery mode</h1>
      <p>Startup failed. Use this page to fix DB runtime settings and restart automatically.</p>
      ${flash}
      ${errorBox}
      <p><strong>Timestamp:</strong> ${escapeHtml(report.occurredAt || "")}</p>
      <p><strong>Version:</strong> ${escapeHtml(report.appVersion || "")} build ${escapeHtml(report.appBuild || "")} (${escapeHtml(report.appCommit || "")})</p>
      <p><strong>Reason:</strong> ${escapeHtml(report.errorName || "Error")}: ${escapeHtml(report.errorMessage || "")}</p>
      <p class="muted">Runtime config file: <code>${escapeHtml(RUNTIME_CONFIG_PATH)}</code></p>
      <p class="muted">Recent crash files:</p>
      <pre>${escapeHtml(recentFiles.length ? recentFiles.join("\n") : "(none)")}</pre>
      ${showStack ? `<p class="muted">Stack trace</p><pre>${escapeHtml(report.stackTrace || "n/a")}</pre>` : ""}
      ${detailText ? `<p class="muted">Details</p><pre>${escapeHtml(detailText)}</pre>` : ""}
    </div>

    <div class="card">
      <h2>Recovery wizard</h2>
      <form method="post" action="/recovery/config" class="grid-1">
        <div>
          <label for="driver">Driver</label>
          <select id="driver" name="driver">
            <option value="sqlite"${selectedDriver === "sqlite" ? " selected" : ""}>SQLite</option>
            <option value="postgres"${selectedDriver === "postgres" ? " selected" : ""}>PostgreSQL</option>
          </select>
        </div>
        <div>
          <label for="sqlitePath">SQLite path</label>
          <input id="sqlitePath" name="sqlitePath" value="${escapeHtml(state.sqlitePath)}" />
        </div>
        <div class="grid">
          <div>
            <label for="host">Postgres host</label>
            <input id="host" name="host" value="${escapeHtml(state.postgres.host)}" />
          </div>
          <div>
            <label for="port">Postgres port</label>
            <input id="port" name="port" type="number" value="${escapeHtml(state.postgres.port)}" />
          </div>
          <div>
            <label for="database">Postgres database</label>
            <input id="database" name="database" value="${escapeHtml(state.postgres.database)}" />
          </div>
          <div>
            <label for="user">Postgres user</label>
            <input id="user" name="user" value="${escapeHtml(state.postgres.user)}" />
          </div>
          <div style="grid-column: 1 / -1;">
            <label for="password">Postgres password (leave empty to keep current runtime value)</label>
            <input id="password" name="password" type="password" autocomplete="new-password" value="" />
          </div>
          <div style="grid-column: 1 / -1;">
            <label for="connectionString">Postgres connection string (optional, overrides host fields)</label>
            <textarea id="connectionString" name="connectionString">${escapeHtml(state.postgres.connectionString || "")}</textarea>
          </div>
        </div>
        <div class="row">
          <button type="submit">Apply runtime config and restart container</button>
          <button class="secondary" type="submit" formaction="/recovery/test-postgres" formmethod="post">Test Postgres settings</button>
        </div>
      </form>
      <p class="muted" style="margin-top:10px">Current recovery report JSON</p>
      <pre>${escapeHtml(reportJson)}</pre>
    </div>
  </div>
</body>
</html>`;
    };

    app.get("/healthz", (req, res) => {
      res.status(503).json({ ok: false, recoveryMode: true });
    });
    app.get("/", (req, res) => {
      res.redirect("/crash");
    });
    app.get("/crash", (req, res) => {
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.status(503).send(renderRecoveryHtml());
    });
    app.post("/recovery/test-postgres", async (req, res) => {
      try {
        const runtime = readRuntimeConfig();
        const existing = runtime?.dbConfig?.postgres || {};
        const pgConfig = parseIncomingPostgres(req.body || {}, existing);
        await probePostgres(pgConfig);
        res.setHeader("content-type", "text/html; charset=utf-8");
        res.status(200).send(renderRecoveryHtml({
          message: "PostgreSQL test succeeded.",
          preferredDriver: "postgres"
        }));
      } catch (err) {
        res.setHeader("content-type", "text/html; charset=utf-8");
        res.status(400).send(renderRecoveryHtml({
          error: String(err?.message || "PostgreSQL test failed."),
          preferredDriver: "postgres"
        }));
      }
    });
    app.post("/recovery/config", (req, res) => {
      try {
        const runtime = readRuntimeConfig();
        const next = {
          ...runtime,
          activeDriver: parseDriver(req.body?.driver, "sqlite"),
          dbConfig: { ...(runtime.dbConfig || {}) },
          dbConfigUpdatedAt: nowIso(),
          dbConfigUpdatedBy: "recovery_wizard"
        };
        if (next.activeDriver === "sqlite") {
          const sqlitePath = String(req.body?.sqlitePath || runtime?.dbConfig?.sqlitePath || process.env.SQLITE_PATH || "/data/ktrain.sqlite").trim();
          next.dbConfig.sqlitePath = sqlitePath || "/data/ktrain.sqlite";
        } else {
          const existingPg = runtime?.dbConfig?.postgres || {};
          next.dbConfig.postgres = parseIncomingPostgres(req.body || {}, existingPg);
        }
        writeRuntimeConfig(next);
        res.setHeader("content-type", "text/html; charset=utf-8");
        res.status(200).send(renderRecoveryHtml({
          message: "Recovery settings saved. Restarting service now...",
          detail: safeJsonStringify({
            activeDriver: next.activeDriver,
            dbConfigUpdatedAt: next.dbConfigUpdatedAt
          }),
          preferredDriver: next.activeDriver
        }));
        // Let the response flush before exiting so Docker restart policy restarts the service.
        setTimeout(() => process.exit(1), 400);
      } catch (err) {
        res.setHeader("content-type", "text/html; charset=utf-8");
        res.status(400).send(renderRecoveryHtml({
          error: String(err?.message || "Failed to save recovery configuration.")
        }));
      }
    });
    app.get("/setup", (req, res) => {
      res.status(200).json({
        ok: true,
        recoveryMode: true,
        message: "Fix DB/configuration and restart service to exit recovery mode.",
        version: this.getBuildInfo()
      });
    });
    app.get("*", (req, res) => {
      res.redirect("/crash");
    });

    this.recoveryServer = app.listen(this.recoveryPort, () => {
      console.error(`CRASH_EVENT ${safeJsonStringify({ type: "recovery_server_started", port: this.recoveryPort })}`);
    });
  }
}

module.exports = {
  CrashHandler,
  deepRedact
};
