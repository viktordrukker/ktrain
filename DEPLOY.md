# Deployment Guide (Hetzner + Docker + Caddy)

## 1) Server Layout
Assumed app directory on Hetzner:
```bash
/opt/ktrain
```

Copy repo there and create `.env` from `.env.example`.

## 2) Required Secrets (GitHub)
Repository settings -> Secrets and variables -> Actions:
- `HETZNER_SSH_HOST`
- `HETZNER_SSH_USER`
- `HETZNER_SSH_KEY`

GHCR push uses `GITHUB_TOKEN` automatically.

## 3) CI/CD
Workflow file: `.github/workflows/deploy.yml`

On push to `main`:
1. Build Docker image
2. Push to `ghcr.io/<owner>/<repo>:latest` and `:sha-...`
3. SSH to Hetzner and run `scripts/deploy_remote.sh`

Manual rollback deploy by tag:
- Use `workflow_dispatch` and set `image_tag`

## 4) First-Time Hetzner Bootstrap
```bash
sudo mkdir -p /opt/ktrain
sudo chown -R $USER:$USER /opt/ktrain
cd /opt/ktrain
# clone repo here
cp .env.example .env
# edit .env (ADMIN_PIN, Postgres creds, auth groups)
docker compose up --build -d
```

## 5) Postgres Optional Start
```bash
docker compose --profile postgres up -d ktrain_postgres
```

## 6) Migrations
Run active backend migration:
```bash
./scripts/db_migrate.sh
```

## 7) Caddy + TLS + Authelia
Use Caddy snippet from `INSTALL.md` section "Caddy Configuration".

## 8) Rollback
Image rollback:
1. Re-run workflow with older `image_tag`
2. Or on server:
```bash
docker pull ghcr.io/viktordrukker/ktrain:<old-tag>
IMAGE=ghcr.io/viktordrukker/ktrain:<old-tag> ./scripts/deploy_remote.sh
```

DB rollback:
```bash
curl -X POST http://127.0.0.1:3000/api/admin/db/rollback \
  -H 'x-admin-pin: <ADMIN_PIN>'
```

## 9) Logs
```bash
docker compose logs -f ktrain
docker compose logs -f ktrain_postgres
```

Request logs include `request_id`.
