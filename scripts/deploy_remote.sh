#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/srv/ktrain}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.prod.yml}"
SERVICE_NAME="${SERVICE_NAME:-ktrain}"

cd "$APP_DIR"

if [ -x "./scripts/deploy-prod.sh" ]; then
  exec ./scripts/deploy-prod.sh "$@"
fi

echo "scripts/deploy-prod.sh not found or not executable; refusing legacy deploy fallback."
exit 1
