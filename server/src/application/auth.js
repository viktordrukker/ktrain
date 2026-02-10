const crypto = require("crypto");
const { Roles } = require("../domain/rbac");

function hashToken(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString("base64url");
}

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

async function getOrCreateUserByEmail(repo, email, role = Roles.USER) {
  const normalized = normalizeEmail(email);
  let user = await repo.findUserByEmail(normalized);
  if (!user) {
    user = await repo.createUser({
      externalSubject: normalized,
      email: normalized,
      displayName: normalized.split("@")[0],
      role
    });
  }
  return user;
}

async function createAuthSession(repo, user, context = {}) {
  const rawToken = randomToken(48);
  const tokenHash = hashToken(rawToken);
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  await repo.createAuthSession({
    userId: user.id,
    tokenHash,
    expiresAt,
    userAgent: context.userAgent || null,
    ip: context.ip || null
  });
  return {
    token: rawToken,
    expiresAt,
    user
  };
}

async function createMagicLink(repo, email, context = {}) {
  const rawToken = randomToken(48);
  const tokenHash = hashToken(rawToken);
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
  await repo.createMagicLink({
    email: normalizeEmail(email),
    tokenHash,
    expiresAt,
    requestedIp: context.ip || null
  });
  return {
    token: rawToken,
    expiresAt
  };
}

async function consumeMagicLink(repo, token, context = {}) {
  const tokenHash = hashToken(token);
  const link = await repo.consumeMagicLink(tokenHash);
  if (!link) return null;
  const email = link.email || link.email;
  const user = await getOrCreateUserByEmail(repo, email, Roles.USER);
  return createAuthSession(repo, user, context);
}

module.exports = {
  hashToken,
  randomToken,
  normalizeEmail,
  getOrCreateUserByEmail,
  createAuthSession,
  createMagicLink,
  consumeMagicLink
};
