#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/ktrain}"
IMAGE="${IMAGE:-ghcr.io/viktordrukker/ktrain:latest}"

cd "$APP_DIR"

echo "Pulling image: $IMAGE"
docker pull "$IMAGE"

echo "Starting services"
docker compose up -d --no-deps ktrain

echo "Running DB migration for active backend"
docker compose exec -T ktrain sh -lc 'cd /app/server && npm run migrate'

echo "Waiting for readiness"
for i in {1..20}; do
  if curl -fsS http://127.0.0.1:3000/readyz >/dev/null; then
    echo "Ready"; exit 0
  fi
  sleep 2
done

echo "Service did not become ready in time"
exit 1
