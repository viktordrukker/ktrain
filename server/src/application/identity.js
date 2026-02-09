const { Roles, normalizeRole, compareRoles } = require("../domain/rbac");

function normalizeIp(ip) {
  if (!ip) return "";
  return String(ip).replace(/^::ffff:/, "");
}

function isPrivateIp(ip) {
  const clean = normalizeIp(ip);
  if (!clean) return false;
  if (clean === "127.0.0.1" || clean === "::1") return true;
  if (clean.startsWith("10.")) return true;
  if (clean.startsWith("192.168.")) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(clean)) return true;
  return false;
}

function parseGroups(req) {
  const raw = req.headers["x-forwarded-groups"] || req.headers["x-auth-request-groups"] || "";
  return String(raw)
    .split(/[;,]/)
    .map((x) => x.trim())
    .filter(Boolean);
}

function canTrustProxyHeaders(req, options) {
  const trustProxy = options.authTrustProxy === true;
  if (!trustProxy) return false;
  const trustedList = options.trustedProxyIps || [];
  const ip = normalizeIp(req.ip || req.socket?.remoteAddress || "");
  if (trustedList.length > 0) return trustedList.includes(ip);
  return isPrivateIp(ip);
}

function inferRoleFromGroups(groups, options) {
  if (groups.some((group) => options.ownerGroups.includes(group))) return Roles.OWNER;
  if (groups.some((group) => options.adminGroups.includes(group))) return Roles.ADMIN;
  if (groups.some((group) => options.moderatorGroups.includes(group))) return Roles.MODERATOR;
  return Roles.USER;
}

async function resolveActor({ req, repo, options, getAdminPin }) {
  const pin = req.headers["x-admin-pin"];
  if (pin && String(pin) === String(getAdminPin())) {
    return {
      isAuthenticated: true,
      authType: "admin_pin",
      externalSubject: "local-pin-admin",
      email: null,
      displayName: "Local Admin",
      role: Roles.OWNER,
      groups: []
    };
  }

  if (!canTrustProxyHeaders(req, options)) {
    return { isAuthenticated: false, authType: "none", role: Roles.GUEST, groups: [] };
  }

  const subject = req.headers["x-forwarded-user"] || req.headers["x-auth-request-user"];
  if (!subject) {
    return { isAuthenticated: false, authType: "proxy", role: Roles.GUEST, groups: [] };
  }

  const externalSubject = String(subject).trim();
  const groups = parseGroups(req);
  const inferredRole = inferRoleFromGroups(groups, options);

  let existing = await repo.findUserByExternalSubject(externalSubject);
  if (!existing) {
    const email = externalSubject.includes("@") ? externalSubject : null;
    const displayName = externalSubject.split("@")[0] || externalSubject;
    const seededRole = options.ownerEmail && email && email.toLowerCase() === options.ownerEmail.toLowerCase()
      ? Roles.OWNER
      : inferredRole;

    // SECURITY: create an internal principal that backend authorization can target.
    existing = await repo.createUser({
      externalSubject,
      email,
      displayName,
      role: seededRole
    });
  }

  const dbRole = normalizeRole(existing.role);
  const effectiveRole = compareRoles(dbRole, inferredRole) >= 0 ? dbRole : inferredRole;
  if (effectiveRole !== dbRole) {
    await repo.updateUserRole(existing.id, effectiveRole, "sync:proxy-groups");
    existing.role = effectiveRole;
  }

  await repo.touchUserLogin(existing.id);

  return {
    id: existing.id,
    isAuthenticated: true,
    authType: "proxy",
    externalSubject,
    email: existing.email,
    displayName: existing.displayName,
    role: normalizeRole(existing.role),
    groups
  };
}

module.exports = {
  resolveActor,
  parseGroups,
  canTrustProxyHeaders,
  inferRoleFromGroups
};
