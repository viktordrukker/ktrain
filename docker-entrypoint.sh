#!/bin/sh
set -eu

# Docker volumes can override image ownership; ensure writable /data each start.
mkdir -p /data
chown -R app:app /data || true

exec su-exec app "$@"
