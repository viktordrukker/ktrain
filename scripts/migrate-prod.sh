#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/srv/ktrain}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.prod.yml}"
SERVICE_NAME="${SERVICE_NAME:-ktrain}"

cd "$APP_DIR"

if [ ! -f "$COMPOSE_FILE" ]; then
  echo "Compose file not found: $COMPOSE_FILE"
  exit 1
fi

CONTAINER_ID="$(docker compose -f "$COMPOSE_FILE" ps -q "$SERVICE_NAME" || true)"
if [ -z "$CONTAINER_ID" ]; then
  echo "Service '$SERVICE_NAME' is not running; cannot run migrations"
  exit 1
fi

ACTIVE_DRIVER="$(docker compose -f "$COMPOSE_FILE" exec -T "$SERVICE_NAME" sh -lc 'printf "%s" "${DB_DRIVER:-sqlite}"' 2>/dev/null || printf "unknown")"
if [ "$ACTIVE_DRIVER" = "postgres" ]; then
  echo "Running production migrations for PostgreSQL backend"
else
  echo "Running production migrations for fallback backend (DB_DRIVER=$ACTIVE_DRIVER)"
fi

docker compose -f "$COMPOSE_FILE" exec -T "$SERVICE_NAME" sh -lc 'cd /app/server && npm run migrate'
echo "Migrations completed successfully"
