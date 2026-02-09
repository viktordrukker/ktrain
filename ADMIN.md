# Admin Operations

## Role Model
- `OWNER`: security-critical control plane, role assignments.
- `ADMIN`: settings/content/config/DB operations.
- `MODERATOR`: diagnostics and audit read.

RBAC is enforced server-side for all protected routes.

## Admin Access Model
- Primary: reverse-proxy identity headers (`x-forwarded-user`, `x-forwarded-groups`).
- Headers are accepted only from trusted proxy IPs.
- Fallback: `x-admin-pin` for local/break-glass admin access.

## Owner Bootstrap
- Preferred: set `OWNER_EMAIL` and restart.
- Alternate (when no owner exists):
```bash
curl -X POST http://127.0.0.1:3000/api/admin/owner/bootstrap \
  -H 'content-type: application/json' \
  -H 'x-admin-pin: <ADMIN_PIN>' \
  -d '{"confirm":true}'
```

## DB Status and Control
- `GET /api/admin/db/status`
- `POST /api/admin/db/switch`
- `POST /api/admin/db/rollback`
- `POST /api/admin/db/migrations/rollback-last`

## Runtime Config Management
- `GET /api/admin/config`
- `POST /api/admin/config`
- `GET /api/admin/config/export`
- `POST /api/admin/config/import`

Only safe keys are accepted:
- `app.settings`
- `app.features`
- `contest.rules`
- `generator.defaults`
- `theme.defaults`

## User and Role Management
- `GET /api/admin/users`
- `POST /api/admin/users/:id/role`

Role assignment is owner-only.

## Diagnostics
- `GET /api/diagnostics/rbac`
- `GET /api/diagnostics/db`
- `GET /api/diagnostics/config`
- `GET /api/diagnostics/encryption`
- `GET /api/diagnostics/startup`

## Audit Logs
- `GET /api/admin/audit-logs?limit=100`
