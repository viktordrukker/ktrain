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
  echo "Image pull failed; deploy will attempt using locally cached image."
fi

echo "Starting services"
# WHY: Deploys must roll forward to the exact pushed image tag; avoid local rebuild drift.
IMAGE="$IMAGE" docker compose up -d --force-recreate --no-build ktrain

echo "Ensuring ktrain is attached to caddy_net"
KTRAIN_IN_CADDY_NET="$(docker inspect -f '{{json .NetworkSettings.Networks.caddy_net}}' ktrain 2>/dev/null || true)"
if [ "$KTRAIN_IN_CADDY_NET" = "null" ] || [ -z "$KTRAIN_IN_CADDY_NET" ]; then
  docker network connect --alias ktrain caddy_net ktrain
fi

echo "Running DB migration for active backend"
docker compose exec -T ktrain sh -lc 'cd /app/server && npm run migrate'

echo "Waiting for readiness"
for i in {1..20}; do
  if ! docker ps --format '{{.Names}}' | grep -qx 'ktrain'; then
    echo "Container exited before readiness check completed."
    docker logs --tail 200 ktrain || true
    exit 1
  fi
  if docker compose exec -T ktrain sh -lc 'wget -qO- http://127.0.0.1:3000/readyz >/dev/null' >/dev/null 2>&1; then
    echo "Ready"; exit 0
  fi
  sleep 2
done

echo "Service did not become ready in time"
docker logs --tail 200 ktrain || true
exit 1
