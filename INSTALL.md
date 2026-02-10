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
- `APP_BASE_URL` (used for magic links)
- `AUTH_TRUST_PROXY=true`
- `AUTH_TRUSTED_PROXY_IPS=<reverse-proxy-ip-list>`

Optional auth:
- `GOOGLE_CLIENT_ID` (enables Google sign-in)

## Email (Magic Link) Setup
Configure SMTP from Admin Service Settings in app UI:
- host, port, username, password
- from address and from name

Notes:
- SMTP password is encrypted at rest.
- Test email endpoint is admin-only.

## Language Packs
- Default EN + RU published packs are auto-seeded on first run.
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

## Migrations
```bash
./scripts/db_migrate.sh
./scripts/migrate_status.sh
```
