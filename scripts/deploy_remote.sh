#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/ktrain}"
IMAGE="${IMAGE:-ghcr.io/viktordrukker/ktrain:latest}"

cd "$APP_DIR"

if ! docker compose version >/dev/null 2>&1; then
  if command -v apt-get >/dev/null 2>&1; then
    sudo apt-get update
    sudo apt-get install -y docker-compose-plugin
  else
    echo "docker compose is missing and cannot be installed automatically on this host"
    exit 1
  fi
fi

if ! docker network inspect caddy_net >/dev/null 2>&1; then
  echo "Creating external network: caddy_net"
  docker network create caddy_net
fi

echo "Pulling image: $IMAGE"
if ! docker pull "$IMAGE"; then
  echo "Image pull failed, falling back to server-side build."
fi

echo "Starting services"
docker compose up -d --build ktrain

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
