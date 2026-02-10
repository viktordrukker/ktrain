#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://127.0.0.1:3000}"
EXPECT_SETUP_REQUIRED="${EXPECT_SETUP_REQUIRED:-false}"

echo "Running KTrain setup/config self-checks against: ${BASE_URL}"

public_status_json="$(curl -fsS "${BASE_URL}/api/public/config/status")"
overall="$(printf '%s' "${public_status_json}" | sed -n 's/.*"overall":"\([^"]*\)".*/\1/p')"
setup_required="$(printf '%s' "${public_status_json}" | sed -n 's/.*"setupRequired":\([^,}]*\).*/\1/p')"

echo "Public config status: overall=${overall:-unknown} setupRequired=${setup_required:-unknown}"

if [[ "${EXPECT_SETUP_REQUIRED}" == "true" ]]; then
  if [[ "${setup_required}" != "true" ]]; then
    echo "FAIL: expected setupRequired=true"
    exit 1
  fi
  echo "PASS: fresh/invalid config correctly reports setup-required"
else
  if [[ "${setup_required}" == "true" ]]; then
    echo "FAIL: expected setupRequired=false"
    exit 1
  fi
  echo "PASS: required config is ready"
fi

ready_code="$(curl -s -o /tmp/ktrain_readyz.out -w '%{http_code}' "${BASE_URL}/readyz" || true)"
if [[ "${EXPECT_SETUP_REQUIRED}" == "true" ]]; then
  [[ "${ready_code}" == "503" ]] || { echo "FAIL: expected /readyz=503 in setup mode"; exit 1; }
  echo "PASS: /readyz blocked while setup required"
else
  [[ "${ready_code}" == "200" ]] || { echo "FAIL: expected /readyz=200 when setup complete"; cat /tmp/ktrain_readyz.out; exit 1; }
  echo "PASS: /readyz healthy"
fi

health_json="$(curl -fsS "${BASE_URL}/healthz")"
echo "Health: ${health_json}"

echo "Self-check complete."
