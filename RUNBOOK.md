# Operations Runbook

## Health and Readiness
- Liveness: `GET /healthz`
- Readiness: `GET /readyz`
- Script: `./scripts/healthcheck.sh`

## Startup and Bootstrap
1. `cp .env.example .env`
2. Configure `ADMIN_PIN`, `OWNER_EMAIL`, `KTRAIN_MASTER_KEY`.
3. `docker compose up --build -d`
4. `./scripts/bootstrap.sh`

## Migrations
- Up: `./scripts/db_migrate.sh`
- Status: `./scripts/migrate_status.sh`
- Rollback last (if down exists): `./scripts/migrate_rollback.sh`

## Backups
- SQLite backup: `./scripts/backup_sqlite.sh`
- SQLite restore: `./scripts/restore_sqlite.sh <archive.tar.gz>`
- Postgres backup: `./scripts/backup_postgres.sh`
- Postgres restore: `./scripts/restore_postgres.sh <dump.sql>`

## DB Switching (Admin Only)
- API: `POST /api/admin/db/switch`
- Rollback: `POST /api/admin/db/rollback`
- Host helper: `ADMIN_PIN=<pin> ./scripts/switch_db.sh postgres`

## Diagnostics (Admin)
- RBAC: `GET /api/diagnostics/rbac`
- DB: `GET /api/diagnostics/db`
- Config: `GET /api/diagnostics/config`
- Encryption: `GET /api/diagnostics/encryption`
- Startup self-checks: `GET /api/diagnostics/startup`

## Incident Basics
1. Enable maintenance flow by pausing write-heavy operations.
2. Capture diagnostics and audit logs.
3. Backup current DB.
4. Roll back DB switch/migration if needed.
5. Redeploy previous image tag.
