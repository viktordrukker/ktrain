# K-Train

Toddler keyboard trainer webapp (React + Node) with Docker-first deployment, production hardening, and dual database backend support:
- `sqlite` (default, file-based)
- `postgres` (optional)

## Highlights
- Learning and contest modes with leaderboard persistence
- Admin-only reset, vocab management, and DB backend switching
- Health endpoints: `/healthz`, `/readyz`
- Adapter-based DAL (`server/db/adapters/sqlite.js`, `server/db/adapters/postgres.js`)
- Safe DB switch flow with dump/verify/rollback
- Docker + GitHub Actions CI/CD + Hetzner deploy script
- Caddy + Authelia ready routing model

## Quick Start (Docker)
```bash
cp .env.example .env
docker compose up --build -d
```
Open `http://localhost:3000`.

## DB Backend Selection
- Default: `DB_DRIVER=sqlite`
- Optional: `DB_DRIVER=postgres` with `ktrain_postgres` container
- Runtime active driver is read from `DB_RUNTIME_CONFIG_PATH` (default `/data/runtime-db.json`)

Admin-only endpoints:
- `GET /api/admin/db/status`
- `POST /api/admin/db/switch`
- `POST /api/admin/db/rollback`

## Authentication Model
- Public: gameplay routes
- Admin: `/admin*`, `/settings-admin*`, `/api/admin/*`, `/api/settings`
- Admin authorization uses reverse-proxy identity headers (`x-forwarded-user`, `x-forwarded-groups`) and `AUTH_ADMIN_GROUPS`
- Local fallback: `x-admin-pin` header

## Core Scripts
- `scripts/db_migrate.sh`
- `scripts/switch_db.sh`
- `scripts/backup_sqlite.sh`
- `scripts/restore_sqlite.sh`
- `scripts/backup_postgres.sh`
- `scripts/restore_postgres.sh`
- `scripts/deploy_remote.sh`

## Docs
- `INSTALL.md`: install + runtime troubleshooting
- `DEPLOY.md`: CI/CD and Hetzner deployment flow
- `ADMIN.md`: admin auth, DB switching, rollback, maintenance
