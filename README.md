# K-Train

Toddler keyboard trainer web app (React + Node) with Docker-first deployment and production-safe backend controls.

## Iteration 2 Highlights
- Multi-language packs with publish workflow (`DRAFT` -> `PUBLISHED`)
- Built-in EN + RU packs seeded automatically
- Auth foundation: Google sign-in + email/password + password reset
- Admin PIN removed; RBAC-only admin authorization
- Global leaderboard for authorized players
- Guest-safe server defaults and separate guest behavior
- Admin service settings (DB + SMTP)
- Crash capture + recovery mode (`/crash`, admin crash diagnostics)
- Live "users playing now" dashboards via heartbeat sessions

## Quick Start
```bash
cp .env.example .env
docker compose up --build -d
./scripts/bootstrap.sh
```

## Core Docs
- `INSTALL.md`
- `ADMIN.md`
- `SECURITY.md`
- `RUNBOOK.md`
