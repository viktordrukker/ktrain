class AppError extends Error {
  constructor(message, { status = 500, code = "INTERNAL_ERROR", expose = false, details = null } = {}) {
    super(message);
    this.name = "AppError";
    this.status = status;
    this.code = code;
    this.expose = expose;
    this.details = details;
  }
}

function badRequest(message, details = null) {
  return new AppError(message, { status: 400, code: "BAD_REQUEST", expose: true, details });
}

function forbidden(message = "Forbidden") {
  return new AppError(message, { status: 403, code: "FORBIDDEN", expose: true });
}

function unauthorized(message = "Unauthorized") {
  return new AppError(message, { status: 401, code: "UNAUTHORIZED", expose: true });
}

module.exports = {
  AppError,
  badRequest,
  forbidden,
  unauthorized
};
