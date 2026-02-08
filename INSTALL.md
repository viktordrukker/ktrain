# Installation and Operations Guide

## 1) System Requirements
- Ubuntu 22.04+ (Hetzner compatible) or any Linux host
- Docker Engine + Docker Compose plugin
- Domain DNS control for `ktrain.thedrukkers.com`
- Caddy reverse proxy (with Authelia integration already present in your stack)

## 2) Quick Start
```bash
cp .env.example .env
docker compose up --build -d
curl -fsS http://127.0.0.1:3000/healthz
```
Open `http://localhost:3000`.

## 3) Environment Variable Reference
Required:
- `PORT=3000`
- `ADMIN_PIN=change-me`
- `OPENAI_MODEL=gpt-4o-mini`

On first deploy, open `Settings / Admin` and rotate the default admin PIN immediately.

Auth:
- `AUTH_TRUST_PROXY=true`
- `AUTH_ADMIN_GROUPS=admins,ldap-admins`

DB driver selection:
- `DB_DRIVER=sqlite|postgres` (default sqlite)
- `DB_RUNTIME_CONFIG_PATH=/data/runtime-db.json`
- `DB_SWITCH_DUMP_DIR=/data/db-switch`
- `DB_SWITCH_AUDIT_LOG=/data/db-switch/switch-audit.log`
- `DB_SWITCH_RESTART_CMD=`
- `DB_SWITCH_POSTGRES_UP_CMD=`

SQLite:
- `SQLITE_PATH=/data/ktrain.sqlite`

Postgres:
- `POSTGRES_HOST=ktrain_postgres`
- `POSTGRES_PORT=5432`
- `POSTGRES_DB=ktrain`
- `POSTGRES_USER=ktrain`
- `POSTGRES_PASSWORD=change-me`

## 4) Port Configuration & Conflicts
Default host mapping is `3000:3000`.

Change host port in `docker-compose.yml`:
```yaml
ports:
  - "8080:3000"
```

If port is already in use:
```bash
sudo ss -ltnp | grep :3000
```
Then stop conflicting service or change mapping.

## 5) SQLite Persistence & Permission Issues
- SQLite data lives in Docker volume `ktrain-data` mounted at `/data`
- Runtime DB switch config and dumps also live under `/data`

Permission problems:
```bash
docker compose exec -T ktrain ls -la /data
```
If needed, recreate volume:
```bash
docker compose down
docker volume rm ktrain_ktrain-data
docker compose up -d
```

## 6) Reset & Recovery Procedures
Admin API reset:
```bash
curl -X POST http://127.0.0.1:3000/api/admin/reset \
  -H 'x-admin-pin: <ADMIN_PIN>' \
  -H 'content-type: application/json' \
  -d '{"scope":"all"}'
```

CLI reset:
```bash
cd server
npm run reset -- all
```

Corrupted DB recovery:
1. Restore from backup script output.
2. If no backup exists, reset the storage volume.

## 7) OpenAI Troubleshooting
- App runs fully without OpenAI.
- For generation errors:
  - Validate server egress connectivity.
  - Validate key permissions/model access.
- Key is never exposed to frontend after submission.

## 8) Docker Debugging
Check status and logs:
```bash
docker compose ps
docker compose logs -f ktrain
```

Container exits immediately:
- verify `.env`
- verify DB credentials
- verify `/data` writable

## 9) Caddy Configuration (TLS + Authelia)
Example Caddy snippet:
```caddyfile
ktrain.thedrukkers.com {
  encode gzip

  @admin path /admin* /settings-admin* /api/admin* /api/settings*
  handle @admin {
    forward_auth authelia:9091 {
      uri /api/authz/forward-auth
      copy_headers Remote-User Remote-Groups
    }
    reverse_proxy ktrain:3000 {
      header_up X-Forwarded-User {http.request.header.Remote-User}
      header_up X-Forwarded-Groups {http.request.header.Remote-Groups}
      header_up X-Request-Id {http.request_id}
    }
  }

  handle {
    reverse_proxy ktrain:3000 {
      header_up X-Request-Id {http.request_id}
    }
  }
}
```

## 10) Performance Notes
- SQLite is ideal for single-node lightweight usage.
- For concurrent write-heavy contests, switch to Postgres.
- Keep Caddy and ktrain on the same Docker network for low latency.

## 11) FAQ / Common Issues
- `vite: not found` during container build:
  - ensure `client/package.json` has build deps and `npm install` succeeds.
- Postgres switch fails:
  - ensure `ktrain_postgres` is running and env credentials match.
- Ready check fails:
```bash
curl -i http://127.0.0.1:3000/readyz
```
- Dropdown/modal styling odd after deploy:
  - hard refresh browser cache after new frontend bundle.

## 12) Child Safety & Data Privacy
- No analytics/ads/tracking included.
- Admin routes are protected by proxy role + server-side checks.
- Keep `.env` and DB dumps private.

## 13) DB Backend Switching
UI first (recommended):
- Open `Settings / Admin` -> `Admin`
- Enter admin PIN
- Configure `SQLite path` or Postgres host/port/db/user/password or full connection string
- Click `Save DB config`
- Click `Switch to SQLite` or `Switch to Postgres`
- Use `Rollback DB switch` if needed

Status:
```bash
curl -s http://127.0.0.1:3000/api/admin/db/status -H 'x-admin-pin: <ADMIN_PIN>'
```

Switch to Postgres:
```bash
curl -X POST http://127.0.0.1:3000/api/admin/db/switch \
  -H 'x-admin-pin: <ADMIN_PIN>' \
  -H 'content-type: application/json' \
  -d '{"target":"postgres","mode":"copy-then-switch","verify":true}'
```

Rollback:
```bash
curl -X POST http://127.0.0.1:3000/api/admin/db/rollback -H 'x-admin-pin: <ADMIN_PIN>'
```

Or host helper:
```bash
ADMIN_PIN=<ADMIN_PIN> ./scripts/switch_db.sh postgres
```

## 14) Backup / Restore
SQLite:
```bash
./scripts/backup_sqlite.sh
./scripts/restore_sqlite.sh ./backups/sqlite_YYYYMMDD_HHMMSS.tar.gz
```

Postgres:
```bash
./scripts/backup_postgres.sh
./scripts/restore_postgres.sh ./backups/postgres_YYYYMMDD_HHMMSS.sql
```

## 15) Hetzner-Friendly Deployment Steps
```bash
sudo apt-get update
sudo apt-get install -y docker.io docker-compose-plugin
sudo usermod -aG docker $USER

mkdir -p /opt/ktrain
cd /opt/ktrain
# clone repo and configure .env
cp .env.example .env

docker compose up --build -d
```
Then route domain via Caddy snippet above.
