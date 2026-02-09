#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

echo "[bootstrap] running migrations"
./scripts/db_migrate.sh

echo "[bootstrap] waiting for service"
for i in {1..30}; do
  if curl -fsS "${KTRAIN_API_BASE:-http://127.0.0.1:3000}/readyz" >/dev/null; then
    break
  fi
  sleep 1
done

echo "[bootstrap] seeding defaults (idempotent)"
curl -fsS -X POST "${KTRAIN_API_BASE:-http://127.0.0.1:3000}/api/admin/seed-defaults" \
  -H "x-admin-pin: ${ADMIN_PIN:-change-me}" >/dev/null || true

echo "[bootstrap] done"
