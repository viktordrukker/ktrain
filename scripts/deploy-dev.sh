#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/srv/ktrain-dev}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.dev.yml}"
SERVICE_NAME="${SERVICE_NAME:-ktrain}"
IMAGE="${IMAGE:-ghcr.io/viktordrukker/ktrain:ktrain-dev}"
READINESS_PATH="${READINESS_PATH:-/healthz}"
READINESS_TIMEOUT_SEC="${READINESS_TIMEOUT_SEC:-180}"
READINESS_POLL_SEC="${READINESS_POLL_SEC:-2}"

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

if [ ! -f "$COMPOSE_FILE" ]; then
  echo "Compose file not found: $COMPOSE_FILE"
  exit 1
fi

if ! docker network inspect caddy_net >/dev/null 2>&1; then
  echo "Creating external network: caddy_net"
  docker network create caddy_net
fi

echo "Pulling dev image: $IMAGE"
if ! docker pull "$IMAGE"; then
  echo "Image pull failed; deploy will attempt using locally cached image."
fi

echo "Resetting runtime DB override file for deterministic SQLite dev mode"
IMAGE="$IMAGE" docker compose -f "$COMPOSE_FILE" run --rm --no-deps "$SERVICE_NAME" sh -lc 'rm -f /data/runtime-db.json'

echo "Starting dev service"
IMAGE="$IMAGE" docker compose -f "$COMPOSE_FILE" up -d --force-recreate --no-build "$SERVICE_NAME"

echo "Running migration for dev runtime backend"
docker compose -f "$COMPOSE_FILE" exec -T "$SERVICE_NAME" sh -lc 'cd /app/server && npm run migrate'

if ! [[ "$READINESS_TIMEOUT_SEC" =~ ^[0-9]+$ ]] || ! [[ "$READINESS_POLL_SEC" =~ ^[0-9]+$ ]] || [ "$READINESS_POLL_SEC" -le 0 ]; then
  echo "Invalid readiness settings: READINESS_TIMEOUT_SEC=$READINESS_TIMEOUT_SEC READINESS_POLL_SEC=$READINESS_POLL_SEC"
  exit 1
fi

echo "Waiting for dev readiness"
ATTEMPTS=$((READINESS_TIMEOUT_SEC / READINESS_POLL_SEC))
if [ "$ATTEMPTS" -lt 1 ]; then
  ATTEMPTS=1
fi

for i in $(seq 1 "$ATTEMPTS"); do
  CONTAINER_ID="$(docker compose -f "$COMPOSE_FILE" ps -q "$SERVICE_NAME" || true)"
  if [ -z "$CONTAINER_ID" ]; then
    echo "Container missing before readiness check completed."
    docker compose -f "$COMPOSE_FILE" logs --tail 200 "$SERVICE_NAME" || true
    exit 1
  fi
  if docker compose -f "$COMPOSE_FILE" exec -T "$SERVICE_NAME" sh -lc "wget -qO- http://127.0.0.1:3000${READINESS_PATH} >/dev/null" >/dev/null 2>&1; then
    echo "Dev deployment ready"
    exit 0
  fi
  HEALTH_STATUS="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$CONTAINER_ID" 2>/dev/null || echo unknown)"
  if [ "$HEALTH_STATUS" = "unhealthy" ]; then
    echo "Container healthcheck reports unhealthy while waiting for readiness."
    docker compose -f "$COMPOSE_FILE" logs --tail 200 "$SERVICE_NAME" || true
    exit 1
  fi
  sleep "$READINESS_POLL_SEC"
done

echo "Dev service did not become ready in time (path=$READINESS_PATH timeout=${READINESS_TIMEOUT_SEC}s)"
docker compose -f "$COMPOSE_FILE" logs --tail 200 "$SERVICE_NAME" || true
exit 1
