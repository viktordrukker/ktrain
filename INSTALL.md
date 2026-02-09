# Installation and Operations Guide

## Quick Start
```bash
cp .env.example .env
docker compose up --build -d
./scripts/bootstrap.sh
```

## Required Production Env
- `ADMIN_PIN` (must not be default)
- `OWNER_EMAIL`
- `KTRAIN_MASTER_KEY` (32-byte hex/base64)
- `AUTH_TRUST_PROXY=true`
- `AUTH_TRUSTED_PROXY_IPS=<comma-separated proxy IPs>`

## Database Driver
- `DB_DRIVER=sqlite|postgres`
- Runtime selection and DB switch metadata are stored in `/data/runtime-db.json`.

## Verification
```bash
./scripts/healthcheck.sh
curl -fsS http://127.0.0.1:3000/api/health
```

## Migrations
```bash
./scripts/db_migrate.sh
./scripts/migrate_status.sh
```

## Backups
```bash
./scripts/backup_sqlite.sh
./scripts/backup_postgres.sh
```

## Diagnostics
Admin endpoints:
- `/api/diagnostics/rbac`
- `/api/diagnostics/db`
- `/api/diagnostics/config`
- `/api/diagnostics/encryption`
- `/api/diagnostics/startup`

## Notes
- Admin authorization is always enforced on the backend.
- Use Postgres for multi-user production scale.
- Keep `.env`, backups, and runtime config files private.
