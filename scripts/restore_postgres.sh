#!/usr/bin/env bash
set -euo pipefail

DUMP_FILE="${1:-}"
if [[ -z "$DUMP_FILE" || ! -f "$DUMP_FILE" ]]; then
  echo "Usage: $0 <dump.sql>"
  exit 1
fi

DB_NAME="${POSTGRES_DB:-ktrain}"
DB_USER="${POSTGRES_USER:-ktrain}"

echo "Restoring postgres from $DUMP_FILE"
docker compose exec -T ktrain_postgres psql -U "$DB_USER" "$DB_NAME" < "$DUMP_FILE"

echo "Done"
