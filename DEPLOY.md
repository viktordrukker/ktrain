# Deployment Guide

## CI/CD Flow
1. Build image
2. Push image
3. Deploy to host
4. Run migrations
5. Restart and verify readiness

## One-Command Remote Deploy
```bash
APP_DIR=/opt/ktrain IMAGE=ghcr.io/<owner>/<repo>:latest ./scripts/deploy_remote.sh
```

## Post-Deploy Checks
```bash
./scripts/healthcheck.sh
curl -fsS http://127.0.0.1:3000/api/diagnostics/startup -H 'x-admin-pin: <ADMIN_PIN>'
```

## Rollback
- Application image rollback: redeploy previous tag.
- Data-plane rollback:
  - `POST /api/admin/db/rollback`
  - `./scripts/migrate_rollback.sh` (if migration down file exists)

## Zero/Low Downtime Notes
- Migrations are idempotent and run on startup.
- DB switch uses copy-then-switch with count verification and rollback path.
