# Deployment Guide

## Detected Environments
- Dev image tags:
  - `ghcr.io/<owner>/<repo>:ktrain-dev`
  - `ghcr.io/<owner>/<repo>:ktrain-dev-<git_sha>`
- Production image tags:
  - `ghcr.io/<owner>/<repo>:ktrain`
  - `ghcr.io/<owner>/<repo>:ktrain-<git_sha>`
  - `ghcr.io/<owner>/<repo>:ktrain-v<app_version>-<run>-<sha12>`

## GitHub Workflows
- `ci-dev.yml`:
  - Trigger: push to `main` (and optional manual run)
  - Runs checks + tests
  - Builds and pushes dev image tags
  - Deploys `ktrain-dev` over SSH to the same host at `DEPLOY_PATH-dev`
- `promote-prod.yml`:
  - Trigger: manual (`workflow_dispatch`)
  - Requires `confirm=PROMOTE`
  - Promotes a verified `ktrain-dev-<sha>` image from successful CI
  - Smoke checks the promoted image
  - Tags/pushes production tags and deploys automatically

## Single-Server Layout
- Production path: `DEPLOY_PATH`
- Dev path: `DEPLOY_PATH-dev`
- Both use the same SSH host/user/key.
- `ktrain-dev` is intended for internal testing behind Caddy + Authelia (attached to `caddy_net`, no direct public port publish).

## Compose Files
- `docker-compose.dev.yml`
  - SQLite runtime (`DB_DRIVER=sqlite`)
  - Persistent volume: `ktrain_dev_data`
  - Env file on server: `.env.dev`
- `docker-compose.prod.yml`
  - PostgreSQL runtime by default (`DB_DRIVER=postgres`)
  - SQLite fallback mode supported via promote input
  - Persistent volume: `ktrain_prod_data` (config + sqlite fallback data)
  - Env file on server: `.env.prod`

## Required GitHub Secrets
- `HETZNER_HOST`
- `HETZNER_PORT`
- `HETZNER_USER`
- `HETZNER_SSH_KEY`
- `DEPLOY_PATH`
- `KTRAIN_MASTER_KEY`

## Migration Behavior
- Dev deploy runs `npm run migrate` inside the running dev container (SQLite).
- Production deploy runs `scripts/migrate-prod.sh`:
  - Postgres mode: runs PostgreSQL migrations during deploy.
  - SQLite fallback mode: runs same migration command for SQLite backend.

## SQLite Fallback for Production
- Run `promote-prod.yml` with `sqlite_mode=true`.
- This sets:
  - `DB_DRIVER=sqlite`
  - `KTRAIN_BOOTSTRAP_DB=/data/ktrain.sqlite`

## Health + Rollback
- Dev deploy waits for `/healthz`.
- Production deploy waits for `/healthz` and rolls back to previous image if migration/readiness fails.
