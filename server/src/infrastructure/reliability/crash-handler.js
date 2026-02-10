const fs = require("fs");
const os = require("os");
const path = require("path");
const express = require("express");

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
    const getSummary = () => this.lastCrashReport || {
      occurredAt: nowIso(),
      errorMessage: "Unknown startup failure",
      appMode: this.getAppMode()
    };

    app.get("/healthz", (req, res) => {
      res.status(503).json({ ok: false, recoveryMode: true });
    });
    app.get("/crash", (req, res) => {
      const report = getSummary();
      const mode = String(this.getAppMode() || "info");
      const showStack = mode === "advanced-debug" || mode === "debug";
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.status(503).send(`<!doctype html><html><head><title>KTrain Recovery Mode</title><style>body{font-family:Arial,sans-serif;padding:24px;background:#111;color:#eee}pre{white-space:pre-wrap;background:#222;padding:12px;border-radius:8px}code{background:#222;padding:2px 4px;border-radius:4px}</style></head><body><h1>Application is in recovery mode</h1><p>Application failed to start. This page is read-only.</p><p><strong>Timestamp:</strong> ${report.occurredAt || ""}</p><p><strong>Version:</strong> ${report.appVersion || ""} build ${report.appBuild || ""} (${report.appCommit || ""})</p><p><strong>Reason:</strong> ${report.errorName || "Error"}: ${report.errorMessage || ""}</p>${showStack ? `<h2>Stack trace</h2><pre>${report.stackTrace || "n/a"}</pre>` : "<p>Stack trace hidden in info mode.</p>"}<p>Use logs and admin recovery setup to fix configuration.</p></body></html>`);
    });
    app.get("/setup", (req, res) => {
      res.status(200).json({
        ok: true,
        recoveryMode: true,
        message: "Fix DB/configuration and restart service to exit recovery mode.",
        version: this.getBuildInfo()
      });
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
