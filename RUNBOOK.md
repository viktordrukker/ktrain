# Operations Runbook

## Health and Readiness
- Liveness: `GET /healthz`
- Readiness: `GET /readyz`
- Script: `./scripts/healthcheck.sh`

## Startup and Bootstrap
1. `cp .env.example .env`
2. Configure `OWNER_EMAIL`, `KTRAIN_MASTER_KEY`, `APP_BASE_URL`.
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
- Host helper: `ADMIN_BEARER_TOKEN=<token> ./scripts/switch_db.sh postgres`

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

## Startup Crash Debugging
1. Check logs:
   - `docker logs --tail 300 ktrain`
2. If startup failed, use recovery endpoints:
   - `GET /crash`
   - `GET /setup`
3. Collect crash evidence:
   - DB table `crash_events`
   - filesystem fallback `/data/crash-reports/*.json`
4. Fix root cause (DB unreachable, migration error, config/secrets mismatch).
5. Restart and verify `GET /readyz` returns 200.

## Crash Acknowledgment
1. Open `Settings -> Admin -> Crash diagnostics`.
2. Review unresolved crashes.
3. Mark handled crashes as acknowledged.
4. Keep unresolved count at zero in normal operations.
