const crypto = require("crypto");
const { hasPermission } = require("../../domain/rbac");
const { forbidden } = require("../../shared/errors");
const logger = require("../../shared/logger");

function requestContextMiddleware() {
  return (req, res, next) => {
    const requestId = req.headers["x-request-id"] || crypto.randomUUID();
    req.requestId = requestId;
    res.setHeader("x-request-id", requestId);
    const started = Date.now();
    res.on("finish", () => {
      logger.info("http_request", {
        requestId,
        ip: req.ip,
        method: req.method,
        path: req.path,
        status: res.statusCode,
        durationMs: Date.now() - started,
        actorRole: req.actor?.role || "GUEST"
      });
    });
    next();
  };
}

function requirePermission(permission) {
  return (req, res, next) => {
    const role = req.actor?.role || "GUEST";
    if (!hasPermission(role, permission)) {
      return next(forbidden("Insufficient permissions"));
    }
    return next();
  };
}

function withAsync(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

function errorHandler() {
  return (err, req, res, next) => {
    const status = Number(err.status || 500);
    const code = err.code || "INTERNAL_ERROR";
    const expose = Boolean(err.expose);
    logger.error("http_error", {
      requestId: req.requestId,
      ip: req.ip,
      method: req.method,
      path: req.path,
      status,
      code,
      error: err
    });
    if (res.headersSent) return next(err);
    return res.status(status).json({
      ok: false,
      error: expose ? err.message : "Internal server error",
      code,
      requestId: req.requestId
    });
  };
}

module.exports = {
  requestContextMiddleware,
  requirePermission,
  withAsync,
  errorHandler
};
