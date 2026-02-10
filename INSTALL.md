# Installation and Operations Guide

## Quick Start
```bash
cp .env.example .env
docker compose up --build -d
./scripts/bootstrap.sh
```

## Iteration 2 Required Env
- `OWNER_EMAIL`
- `KTRAIN_MASTER_KEY` (32-byte hex/base64)
- `APP_BASE_URL` (used for password reset links)
- `APP_MODE` (`info`|`debug`|`advanced-debug`)
- `AUTH_TRUST_PROXY=true`
- `AUTH_TRUSTED_PROXY_IPS=<reverse-proxy-ip-list>`

Optional auth:
- `GOOGLE_CLIENT_ID` (enables Google sign-in)

## Email (Password Reset) Setup
Configure SMTP from Admin Service Settings in app UI:
- host, port, username, password
- from address and from name

Notes:
- SMTP password is encrypted at rest.
- Test email endpoint is admin-only.
- Password reset email flow is disabled until SMTP is configured.

## Language Packs
- Default EN + RU published packs are auto-seeded on first run and re-seeded if missing.
- If OpenAI key is configured for an admin user, draft pack generation is available.
- Only published packs are playable.

## Health + Diagnostics
```bash
./scripts/healthcheck.sh
curl -fsS http://127.0.0.1:3000/api/health
```
Admin diagnostics:
- `/api/diagnostics/rbac`
- `/api/diagnostics/db`
- `/api/diagnostics/config`
- `/api/diagnostics/encryption`
- `/api/diagnostics/startup`
- `/api/admin/crashes` (admin-only crash history)

## Crash Handling & Recovery
- Fatal crashes create redacted structured reports.
- Primary storage: `crash_events` DB table.
- Fallback storage: `${CRASH_REPORTS_DIR:-/data/crash-reports}` JSON files.
- If startup fails, service enters recovery mode exposing:
  - `/healthz` (failed)
  - `/crash` (read-only crash summary page)
  - `/setup` (recovery instructions)
- Optional operator notification:
  - configure `CRASH_ALERT_EMAILS` and SMTP settings in Admin UI.

## Migrations
```bash
./scripts/db_migrate.sh
./scripts/migrate_status.sh
```
