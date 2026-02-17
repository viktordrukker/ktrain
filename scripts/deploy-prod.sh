#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/srv/ktrain}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.prod.yml}"
SERVICE_NAME="${SERVICE_NAME:-ktrain}"
IMAGE="${IMAGE:-ghcr.io/viktordrukker/ktrain:ktrain}"
READINESS_PATH="${READINESS_PATH:-/healthz}"
READINESS_TIMEOUT_SEC="${READINESS_TIMEOUT_SEC:-240}"
READINESS_POLL_SEC="${READINESS_POLL_SEC:-2}"
PROD_CADDY_ALIAS="${PROD_CADDY_ALIAS:-ktrain}"
FORCE_SQLITE_MODE="${FORCE_SQLITE_MODE:-false}"
EFFECTIVE_SQLITE_MODE="$FORCE_SQLITE_MODE"
ENV_FILE="${ENV_FILE:-.env.prod}"

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

PREVIOUS_IMAGE=""
PREVIOUS_CONTAINER_ID="$(docker compose -f "$COMPOSE_FILE" ps -q "$SERVICE_NAME" || true)"
if [ -n "$PREVIOUS_CONTAINER_ID" ]; then
  PREVIOUS_IMAGE="$(docker inspect -f '{{.Config.Image}}' "$PREVIOUS_CONTAINER_ID" 2>/dev/null || true)"
fi

rollback() {
  if [ -z "$PREVIOUS_IMAGE" ]; then
    echo "Rollback skipped: no previous image found."
    return 0
  fi
  echo "Rolling back to previous image: $PREVIOUS_IMAGE"
  IMAGE="$PREVIOUS_IMAGE" docker compose -f "$COMPOSE_FILE" up -d --force-recreate --no-build "$SERVICE_NAME" || true
}

upsert_env() {
  key="$1"
  value="$2"
  file="$3"
  escaped="$(printf '%s' "$value" | sed -e 's/[|&]/\\&/g')"
  if grep -q "^${key}=" "$file"; then
    sed -i "s|^${key}=.*$|${key}=${escaped}|" "$file"
  else
    printf '%s=%s\n' "$key" "$value" >> "$file"
  fi
}

enable_sqlite_fallback() {
  EFFECTIVE_SQLITE_MODE="true"
  if [ -f "$ENV_FILE" ]; then
    upsert_env "DB_DRIVER" "sqlite" "$ENV_FILE"
    upsert_env "KTRAIN_BOOTSTRAP_DB" "/data/ktrain.sqlite" "$ENV_FILE"
  fi
  echo "No valid PostgreSQL bootstrap config found. Falling back to SQLite bootstrap mode."
}

preflight_postgres() {
  if [ "$EFFECTIVE_SQLITE_MODE" = "true" ]; then
    return 0
  fi
  echo "Preflight: validating PostgreSQL connectivity from persisted runtime/env config"
  IMAGE="$IMAGE" docker compose -f "$COMPOSE_FILE" run --rm --no-deps "$SERVICE_NAME" sh -lc 'cd /app/server && node - <<'"'"'JS'"'"'
const fs = require("fs");
const { Pool } = require("pg");

const runtimePath = process.env.DB_RUNTIME_CONFIG_PATH || "/data/runtime-db.json";

function isPlaceholderHost(host) {
  const v = String(host || "").trim().toLowerCase();
  return !v || v === "ktrain_postgres" || v === "postgres";
}

function isPlaceholderPassword(password) {
  const v = String(password || "").trim();
  return !v || v === "change-me" || v === "stillnobodypasseshere";
}

function isPlaceholderConnectionString(dsn) {
  const v = String(dsn || "").trim();
  if (!v) return true;
  if (!/^postgres(ql)?:\/\//i.test(v)) return true;
  return /change-me|stillnobodypasseshere|@ktrain_postgres[:/]|@postgres[:/]/i.test(v);
}

function readRuntime() {
  try {
    return JSON.parse(fs.readFileSync(runtimePath, "utf8"));
  } catch {
    return {};
  }
}

function resolvePostgresConfig() {
  const runtime = readRuntime();
  const runtimeDriver = String(runtime?.activeDriver || "").toLowerCase();
  const runtimePg = runtime?.dbConfig?.postgres || {};
  if (runtimeDriver === "postgres") {
    const runtimeConn = String(runtimePg.connectionString || "").trim();
    if (runtimeConn && !isPlaceholderConnectionString(runtimeConn)) {
      return { source: "runtime.connectionString", config: { connectionString: runtimeConn } };
    }
    if (
      !isPlaceholderHost(runtimePg.host) &&
      String(runtimePg.database || "").trim() &&
      String(runtimePg.user || "").trim() &&
      !isPlaceholderPassword(runtimePg.password)
    ) {
      return {
        source: "runtime.postgresFields",
        config: {
          host: String(runtimePg.host),
          port: Number(runtimePg.port || 5432),
          database: String(runtimePg.database),
          user: String(runtimePg.user),
          password: String(runtimePg.password || "")
        }
      };
    }
  }

  const bootstrap = String(process.env.KTRAIN_BOOTSTRAP_DB || "").trim();
  if (bootstrap) {
    if (/^postgres(ql)?:\/\//i.test(bootstrap) && !isPlaceholderConnectionString(bootstrap)) {
      return { source: "env.KTRAIN_BOOTSTRAP_DB", config: { connectionString: bootstrap } };
    }
  }

  const host = String(process.env.POSTGRES_HOST || "").trim();
  const database = String(process.env.POSTGRES_DB || "").trim();
  const user = String(process.env.POSTGRES_USER || "").trim();
  const password = String(process.env.POSTGRES_PASSWORD || "").trim();
  if (!isPlaceholderHost(host) && database && user && !isPlaceholderPassword(password)) {
    return {
      source: "env.POSTGRES_*",
      config: {
        host,
        port: Number(process.env.POSTGRES_PORT || 5432),
        database,
        user,
        password
      }
    };
  }

  return null;
}

(async () => {
  const resolved = resolvePostgresConfig();
  if (!resolved) {
    console.error("PostgreSQL preflight skipped: no valid postgres runtime/env config detected");
    process.exit(42);
    return;
  }
  const pool = new Pool({
    max: 1,
    connectionTimeoutMillis: Number(process.env.POSTGRES_CONNECT_TIMEOUT_MS || 10000),
    idleTimeoutMillis: Number(process.env.POSTGRES_IDLE_TIMEOUT_MS || 30000),
    ...resolved.config
  });
  try {
    await pool.query("SELECT 1");
    console.log(`PostgreSQL preflight passed (source=${resolved.source})`);
  } catch (err) {
    const message = String(err && err.message ? err.message : "PostgreSQL preflight failed");
    console.error(`PostgreSQL preflight failed: ${message}`);
    process.exitCode = 43;
  } finally {
    await pool.end().catch(() => null);
  }
})();
JS'
}

wait_ready() {
  attempts=$((READINESS_TIMEOUT_SEC / READINESS_POLL_SEC))
  if [ "$attempts" -lt 1 ]; then
    attempts=1
  fi
  for i in $(seq 1 "$attempts"); do
    container_id="$(docker compose -f "$COMPOSE_FILE" ps -q "$SERVICE_NAME" || true)"
    if [ -z "$container_id" ]; then
      echo "Container missing before readiness check completed."
      docker compose -f "$COMPOSE_FILE" logs --tail 200 "$SERVICE_NAME" || true
      return 1
    fi
    if docker compose -f "$COMPOSE_FILE" exec -T "$SERVICE_NAME" sh -lc "wget -qO- http://127.0.0.1:3000${READINESS_PATH} >/dev/null" >/dev/null 2>&1; then
      echo "Ready"
      return 0
    fi
    health_status="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$container_id" 2>/dev/null || echo unknown)"
    if [ "$health_status" = "unhealthy" ]; then
      echo "Container healthcheck reports unhealthy while waiting for readiness."
      docker compose -f "$COMPOSE_FILE" logs --tail 200 "$SERVICE_NAME" || true
      return 1
    fi
    sleep "$READINESS_POLL_SEC"
  done
  echo "Service did not become ready in time (path=$READINESS_PATH timeout=${READINESS_TIMEOUT_SEC}s)"
  docker compose -f "$COMPOSE_FILE" logs --tail 200 "$SERVICE_NAME" || true
  return 1
}

if ! [[ "$READINESS_TIMEOUT_SEC" =~ ^[0-9]+$ ]] || ! [[ "$READINESS_POLL_SEC" =~ ^[0-9]+$ ]] || [ "$READINESS_POLL_SEC" -le 0 ]; then
  echo "Invalid readiness settings: READINESS_TIMEOUT_SEC=$READINESS_TIMEOUT_SEC READINESS_POLL_SEC=$READINESS_POLL_SEC"
  exit 1
fi

if [ "$EFFECTIVE_SQLITE_MODE" = "true" ]; then
  echo "Production SQLite fallback mode requested (FORCE_SQLITE_MODE=true)"
else
  echo "Production PostgreSQL mode (default)"
fi

echo "Pulling image: $IMAGE"
if ! docker pull "$IMAGE"; then
  echo "Image pull failed; deploy will attempt using locally cached image."
fi

set +e
preflight_postgres
PREFLIGHT_RC=$?
set -e

if [ "$PREFLIGHT_RC" -eq 42 ]; then
  enable_sqlite_fallback
elif [ "$PREFLIGHT_RC" -ne 0 ]; then
  echo "PostgreSQL preflight failed; deployment aborted before container replacement."
  exit 1
fi

echo "Starting production service"
IMAGE="$IMAGE" docker compose -f "$COMPOSE_FILE" up -d --force-recreate --no-build "$SERVICE_NAME"

CONTAINER_ID="$(docker compose -f "$COMPOSE_FILE" ps -q "$SERVICE_NAME" || true)"
if [ -z "$CONTAINER_ID" ]; then
  echo "Failed to resolve container id for service '$SERVICE_NAME'"
  rollback
  exit 1
fi

echo "Ensuring service is attached to caddy_net"
IN_CADDY_NET="$(docker inspect -f '{{json .NetworkSettings.Networks.caddy_net}}' "$CONTAINER_ID" 2>/dev/null || true)"
if [ "$IN_CADDY_NET" = "null" ] || [ -z "$IN_CADDY_NET" ]; then
  docker network connect --alias "$PROD_CADDY_ALIAS" caddy_net "$CONTAINER_ID"
fi

echo "Running production migration step"
if ! APP_DIR="$APP_DIR" COMPOSE_FILE="$COMPOSE_FILE" SERVICE_NAME="$SERVICE_NAME" ./scripts/migrate-prod.sh; then
  echo "Migration failed; attempting rollback."
  rollback
  if ! wait_ready; then
    echo "Rollback completed but previous service failed readiness."
  fi
  exit 1
fi

echo "Waiting for production readiness"
if ! wait_ready; then
  echo "Readiness failed; attempting rollback."
  rollback
  if ! wait_ready; then
    echo "Rollback completed but previous service failed readiness as well."
  fi
  exit 1
fi

echo "Production deploy completed successfully"
