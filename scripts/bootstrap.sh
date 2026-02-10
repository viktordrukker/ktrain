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

echo "[bootstrap] done (default packs are auto-seeded at startup when missing)"
