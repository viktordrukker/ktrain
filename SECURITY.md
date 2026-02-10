# Security Guide

## Threat Model Summary
- Public gameplay endpoints are internet-facing.
- Admin/owner operations are high-impact and must be server-authorized.
- Reverse-proxy identity headers are trusted only when requests come from trusted proxy IPs.

## RBAC Roles
- `OWNER`: security-critical settings, role assignment, DB switch/rollback, diagnostics, audit access.
- `ADMIN`: operational admin actions, config management, vocab/content controls.
- `MODERATOR`: diagnostics and audit read access.
- `USER`: authenticated gameplay.
- `GUEST`: unauthenticated gameplay.

Policy source of truth: `server/src/domain/rbac.js`.

## Auth Integration
- Primary mode: reverse-proxy headers (`x-forwarded-user`, `x-forwarded-groups`).
- Header trust guard:
  - `AUTH_TRUST_PROXY=true`
  - `AUTH_TRUSTED_PROXY_IPS` allowlist (recommended) or private-network fallback.
- Session auth mode: Google token exchange or email magic link, then bearer token.

## Owner Bootstrap
- Preferred: `OWNER_EMAIL` environment variable.
- Alternate: `POST /api/admin/owner/bootstrap` with `{"confirm": true}` when no owner exists.

## Secrets Handling
- Per-user OpenAI keys are stored encrypted in `user_secrets` using AES-256-GCM.
- Master key: `KTRAIN_MASTER_KEY` (32-byte key in hex or base64).
- Secrets are never returned in API responses and must never be logged.

## OWASP Controls Implemented
- Request validation at API boundaries.
- Secure headers via Helmet.
- Backend authorization for protected routes.
- Rate limiting on result and generation/admin endpoints.
- Safe error handler (no stack traces to clients).
- Audit logging for privileged actions.

## Operational Security Checklist
- [ ] Set `OWNER_EMAIL`.
- [ ] Set `KTRAIN_MASTER_KEY`.
- [ ] Set `AUTH_TRUSTED_PROXY_IPS` to your reverse proxy IP(s).
- [ ] Use Postgres for high-concurrency production workloads.
- [ ] Restrict DB backups and runtime config files to admins.
