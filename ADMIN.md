# Admin Operations

## Admin Access Model
Admin checks are server-side.

Accepted admin identity:
- Reverse proxy headers from Authelia:
  - `x-forwarded-user`
  - `x-forwarded-groups`
- Group match against `AUTH_ADMIN_GROUPS`

Fallback for local/dev:
- `x-admin-pin: <ADMIN_PIN>`

## Admin-only Routes
- `/api/admin/*`
- `/api/settings`
- Frontend pages `/admin*`, `/settings-admin*`

## DB Status
```bash
curl -s http://127.0.0.1:3000/api/admin/db/status -H 'x-admin-pin: <ADMIN_PIN>'
```

UI path:
- `Settings / Admin` -> `Admin` section -> `Database status`
- Enter admin PIN, click `Refresh DB status`
- Edit SQLite/Postgres config, then `Save DB config`
- Use `Switch to SQLite`, `Switch to Postgres`, or `Rollback DB switch`

## DB Switch (copy-then-switch)
```bash
curl -X POST http://127.0.0.1:3000/api/admin/db/switch \
  -H 'content-type: application/json' \
  -H 'x-admin-pin: <ADMIN_PIN>' \
  -d '{"target":"postgres","mode":"copy-then-switch","verify":true}'
```

Behavior:
1. Enables maintenance mode
2. Dumps source DB to `/data/db-switch/*.json`
3. Restores into target DB
4. Verifies table counts
5. Updates runtime config (`/data/runtime-db.json`)
6. Optionally executes restart command (`DB_SWITCH_RESTART_CMD`)

## Rollback
```bash
curl -X POST http://127.0.0.1:3000/api/admin/db/rollback -H 'x-admin-pin: <ADMIN_PIN>'
```

## Maintenance Safety
During switch/rollback:
- New game/task generation and result writes are blocked with `503`

## Audit Trail
Switch attempts are appended to:
- `DB_SWITCH_AUDIT_LOG` (default `/data/db-switch/switch-audit.log`)

## Backup and Restore
SQLite:
- `scripts/backup_sqlite.sh`
- `scripts/restore_sqlite.sh`

Postgres:
- `scripts/backup_postgres.sh`
- `scripts/restore_postgres.sh`
