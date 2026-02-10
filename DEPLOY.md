# Deployment Guide

## CI/CD Flow
1. Build image
2. Push image
3. Deploy to host
4. Run migrations
5. Restart and verify readiness

## Required Runtime Config
- `OWNER_EMAIL`
- `KTRAIN_MASTER_KEY`
- `APP_BASE_URL`
- `AUTH_TRUST_PROXY=true`
- `AUTH_TRUSTED_PROXY_IPS`

Optional:
- `GOOGLE_CLIENT_ID` for Google sign-in

## Post-Deploy Validation
```bash
./scripts/healthcheck.sh
curl -fsS http://127.0.0.1:3000/api/diagnostics/startup -H 'Authorization: Bearer <ADMIN_TOKEN>'
```

## Rollback
- App image rollback: deploy previous image tag.
- Data plane rollback:
  - `POST /api/admin/db/rollback`
  - `./scripts/migrate_rollback.sh` (if down migration exists)
