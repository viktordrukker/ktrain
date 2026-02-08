#!/usr/bin/env bash
set -euo pipefail

mkdir -p ./backups
STAMP="$(date +%Y%m%d_%H%M%S)"
OUT="./backups/postgres_${STAMP}.sql"

DB_NAME="${POSTGRES_DB:-ktrain}"
DB_USER="${POSTGRES_USER:-ktrain}"

echo "Backing up postgres to $OUT"
docker compose exec -T ktrain_postgres pg_dump -U "$DB_USER" "$DB_NAME" > "$OUT"

echo "Done"
