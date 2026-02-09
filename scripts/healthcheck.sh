#!/usr/bin/env bash
set -euo pipefail

API_BASE="${KTRAIN_API_BASE:-http://127.0.0.1:3000}"

curl -fsS "$API_BASE/healthz" >/dev/null
curl -fsS "$API_BASE/readyz" >/dev/null

echo "healthcheck ok"
