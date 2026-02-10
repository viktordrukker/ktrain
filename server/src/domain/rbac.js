const Roles = Object.freeze({
  OWNER: "OWNER",
  ADMIN: "ADMIN",
  MODERATOR: "MODERATOR",
  USER: "USER",
  GUEST: "GUEST"
});

const Permissions = Object.freeze({
  SESSION_READ: "session:read",
  TASKS_GENERATE: "tasks:generate",
  RESULTS_WRITE: "results:write",
  LEADERBOARD_READ: "leaderboard:read",
  VOCAB_READ: "vocab:read",
  VOCAB_MANAGE: "vocab:manage",
  SETTINGS_READ: "settings:read",
  SETTINGS_WRITE: "settings:write",
  ADMIN_RESET: "admin:reset",
  ADMIN_SEED_DEFAULTS: "admin:seed-defaults",
  ADMIN_DB_READ: "admin:db:read",
  ADMIN_DB_CONFIG: "admin:db:config",
  ADMIN_DB_SWITCH: "admin:db:switch",
  ADMIN_DB_ROLLBACK: "admin:db:rollback",
  ADMIN_DB_TEST: "admin:db:test",
  ADMIN_DIAGNOSTICS_READ: "admin:diagnostics:read",
  ADMIN_CONFIG_MANAGE: "admin:config:manage",
  ADMIN_CONFIG_PORTABILITY: "admin:config:portability",
  ADMIN_SECRET_MANAGE: "admin:secret:manage",
  ADMIN_AUDIT_READ: "admin:audit:read",
  USER_ROLE_ASSIGN: "user:role:assign",
  OWNER_BOOTSTRAP: "owner:bootstrap"
});

const roleHierarchy = {
  [Roles.GUEST]: 0,
  [Roles.USER]: 1,
  [Roles.MODERATOR]: 2,
  [Roles.ADMIN]: 3,
  [Roles.OWNER]: 4
};

const permissionMatrix = {
  [Roles.GUEST]: [
    Permissions.SESSION_READ,
    Permissions.TASKS_GENERATE,
    Permissions.RESULTS_WRITE,
    Permissions.LEADERBOARD_READ,
    Permissions.VOCAB_READ
  ],
  [Roles.USER]: [
    Permissions.SESSION_READ,
    Permissions.TASKS_GENERATE,
    Permissions.RESULTS_WRITE,
    Permissions.LEADERBOARD_READ,
    Permissions.VOCAB_READ
  ],
  [Roles.MODERATOR]: [
    Permissions.SESSION_READ,
    Permissions.TASKS_GENERATE,
    Permissions.RESULTS_WRITE,
    Permissions.LEADERBOARD_READ,
    Permissions.VOCAB_READ,
    Permissions.ADMIN_DIAGNOSTICS_READ,
    Permissions.ADMIN_AUDIT_READ
  ],
  [Roles.ADMIN]: [
    Permissions.SESSION_READ,
    Permissions.TASKS_GENERATE,
    Permissions.RESULTS_WRITE,
    Permissions.LEADERBOARD_READ,
    Permissions.VOCAB_READ,
    Permissions.VOCAB_MANAGE,
    Permissions.SETTINGS_READ,
    Permissions.SETTINGS_WRITE,
    Permissions.ADMIN_RESET,
    Permissions.ADMIN_SEED_DEFAULTS,
    Permissions.ADMIN_DB_READ,
    Permissions.ADMIN_DB_CONFIG,
    Permissions.ADMIN_DB_SWITCH,
    Permissions.ADMIN_DB_ROLLBACK,
    Permissions.ADMIN_DB_TEST,
    Permissions.ADMIN_DIAGNOSTICS_READ,
    Permissions.ADMIN_CONFIG_MANAGE,
    Permissions.ADMIN_CONFIG_PORTABILITY,
    Permissions.ADMIN_SECRET_MANAGE,
    Permissions.ADMIN_AUDIT_READ,
    Permissions.OWNER_BOOTSTRAP
  ],
  [Roles.OWNER]: Object.values(Permissions)
};

function normalizeRole(role) {
  if (!role) return Roles.GUEST;
  const candidate = String(role).toUpperCase();
  return Roles[candidate] || Roles.GUEST;
}

function hasPermission(role, permission) {
  const normalized = normalizeRole(role);
  const granted = permissionMatrix[normalized] || [];
  return granted.includes(permission);
}

function compareRoles(a, b) {
  return (roleHierarchy[normalizeRole(a)] || 0) - (roleHierarchy[normalizeRole(b)] || 0);
}

module.exports = {
  Roles,
  Permissions,
  permissionMatrix,
  roleHierarchy,
  normalizeRole,
  hasPermission,
  compareRoles
};
