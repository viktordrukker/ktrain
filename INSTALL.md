# Installation and Operations Guide

## Quick Start
```bash
cp .env.example .env
docker compose up --build -d
./scripts/bootstrap.sh
```

## Bootstrap Runtime Env (Minimal)
Required:
- `KTRAIN_MASTER_KEY` (32-byte hex/base64)
- `KTRAIN_BOOTSTRAP_DB` (sqlite path or postgres connection string for first boot / fallback)

Optional:
- `NODE_ENV` / `APP_ENV`

All operational settings are DB-backed after bootstrap and should be changed from Settings/Admin.

## Setup Mode Lifecycle
- On startup, server computes `ConfigStatus` from DB-backed config.
- If required checks fail (`database`, `adminUser`), app enters `SETUP_REQUIRED` mode.
- In setup mode:
  - `/readyz` returns `503`
  - `/setup` and `/api/setup/*` are available
  - normal app routes are gated
- Once required checks pass, setup mode exits automatically without redeploy.

Public status probe:
```bash
curl -fsS http://127.0.0.1:3000/api/public/config/status
```

## Email (Password Reset) Setup
Configure SMTP from Admin Service Settings in app UI:
- enabled
- host, port, username, password
- from address and from name

Notes:
- SMTP password is encrypted at rest.
- Test email endpoint is admin-only.
- Password reset email flow is feature-gated until SMTP is valid.
- SMTP failure causes `DEGRADED` mode (not `SETUP_REQUIRED`).

## Language Packs
- Default EN + RU published packs are auto-seeded on first run and re-seeded if missing.
- If OpenAI key is configured for an admin user, draft pack generation is available.
- Only published packs are playable.

## Health + Diagnostics
```bash
./scripts/healthcheck.sh
curl -fsS http://127.0.0.1:3000/api/health
./scripts/self_check_setup.sh
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

## Troubleshooting
- DB unreachable:
  - `/readyz` fails and startup may enter recovery mode.
  - check `KTRAIN_BOOTSTRAP_DB` and runtime DB config.
- Setup required:
  - `/api/public/config/status` returns `setupRequired=true`.
  - open `/setup` and complete required steps.
- Degraded mode:
  - app runs, but optional features (SMTP/Google/OpenAI) are disabled until remediated in Settings/Admin.
