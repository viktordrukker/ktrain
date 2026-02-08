#!/usr/bin/env bash
set -euo pipefail

mkdir -p ./backups
STAMP="$(date +%Y%m%d_%H%M%S)"
OUT="./backups/sqlite_${STAMP}.tar.gz"

echo "Backing up sqlite data from container to $OUT"
docker compose exec -T ktrain sh -lc 'tar -czf - -C /data .' > "$OUT"

echo "Done"
