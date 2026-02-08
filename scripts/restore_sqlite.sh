#!/usr/bin/env bash
set -euo pipefail

ARCHIVE="${1:-}"
if [[ -z "$ARCHIVE" || ! -f "$ARCHIVE" ]]; then
  echo "Usage: $0 <backup-archive.tar.gz>"
  exit 1
fi

echo "Restoring sqlite data from $ARCHIVE"
cat "$ARCHIVE" | docker compose exec -T ktrain sh -lc 'rm -rf /data/* && tar -xzf - -C /data'

echo "Done"
