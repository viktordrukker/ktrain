function safeString(value) {
  if (value === undefined || value === null) return "";
  return String(value);
}

function base(level, event, fields = {}) {
  const payload = {
    ts: new Date().toISOString(),
    level,
    event,
    ...fields
  };
  if (payload.error && payload.error.stack) {
    payload.error = {
      message: payload.error.message,
      name: payload.error.name
    };
  }
  return JSON.stringify(payload);
}

function info(event, fields) {
  console.log(base("info", safeString(event), fields));
}

function warn(event, fields) {
  console.warn(base("warn", safeString(event), fields));
}

function error(event, fields) {
  console.error(base("error", safeString(event), fields));
}

module.exports = {
  info,
  warn,
  error
};
