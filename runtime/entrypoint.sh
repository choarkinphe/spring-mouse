#!/bin/sh
set -eu
mkdir -p /app/data /app/data/db /app/data/redis /app/data-home
chown -R node:node /app/data /app/data-home 2>/dev/null || true
exec su-exec node "$@"
