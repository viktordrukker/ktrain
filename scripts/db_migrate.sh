#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR/server"

echo "Running migrations for driver: ${DB_DRIVER:-sqlite}"
node -e 'const { initDb } = require("./db"); (async()=>{ const { adapter, driver } = await initDb(); await adapter.ping(); await adapter.close(); console.log(`Migration ok for ${driver}`); })().catch(err=>{ console.error(err); process.exit(1); });'
