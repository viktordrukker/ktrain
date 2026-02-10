#!/usr/bin/env bash
set -euo pipefail

# Usage:
# ./scripts/switch_db.sh postgres
# ./scripts/switch_db.sh sqlite

TARGET="${1:-}"
if [[ "$TARGET" != "sqlite" && "$TARGET" != "postgres" ]]; then
  echo "Usage: $0 <sqlite|postgres>"
  exit 1
fi

API_BASE="${KTRAIN_API_BASE:-http://127.0.0.1:3000}"
ADMIN_BEARER_TOKEN="${ADMIN_BEARER_TOKEN:-}"

if [[ -z "$ADMIN_BEARER_TOKEN" ]]; then
  echo "ADMIN_BEARER_TOKEN env var is required"
  exit 1
fi

echo "Requesting DB switch to $TARGET"
curl -fsS -X POST "$API_BASE/api/admin/db/switch" \
  -H "content-type: application/json" \
  -H "Authorization: Bearer $ADMIN_BEARER_TOKEN" \
  -d "{\"target\":\"$TARGET\",\"mode\":\"copy-then-switch\",\"verify\":true}" >/tmp/ktrain-switch-result.json

cat /tmp/ktrain-switch-result.json

echo "Restarting services"
docker compose up -d ktrain
if [[ "$TARGET" == "postgres" ]]; then
  docker compose up -d ktrain_postgres
fi

echo "Switch complete"
