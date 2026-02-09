const { badRequest } = require("../../shared/errors");

function asString(value, { min = 0, max = 4096, field }) {
  const text = String(value ?? "").trim();
  if (text.length < min || text.length > max) {
    throw badRequest(`Invalid ${field}`);
  }
  return text;
}

function asEnum(value, allowed, field) {
  if (!allowed.includes(value)) {
    throw badRequest(`Invalid ${field}`);
  }
  return value;
}

function asNumber(value, { min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER, field, fallback } = {}) {
  const num = Number(value);
  if (Number.isNaN(num)) {
    if (fallback !== undefined) return fallback;
    throw badRequest(`Invalid ${field}`);
  }
  if (num < min || num > max) {
    throw badRequest(`Invalid ${field}`);
  }
  return num;
}

function asBoolean(value, fallback = false) {
  if (value === undefined) return fallback;
  return Boolean(value);
}

function requireObject(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw badRequest(`Invalid ${field}`);
  }
  return value;
}

function parseJsonArrayOfStrings(value, field, maxItems = 500) {
  if (!Array.isArray(value)) throw badRequest(`Invalid ${field}`);
  if (value.length > maxItems) throw badRequest(`Too many ${field}`);
  return value.map((item) => asString(item, { min: 1, max: 64, field }));
}

module.exports = {
  asString,
  asEnum,
  asNumber,
  asBoolean,
  requireObject,
  parseJsonArrayOfStrings
};
