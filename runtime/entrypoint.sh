#!/bin/sh
# Container entrypoint. Runs BEFORE any application process, which is the only
# moment the database file can be replaced safely — see the header of
# src/lib/backup/restore.js for why an in-place swap during runtime cannot work.
#
# THE RESTORE CONTRACT: the app stages a verified snapshot and writes a marker
# file, then exits. The container's `restart: always` brings it back, this script
# applies the swap, removes the marker, and only then starts the app. If the swap
# fails the marker is removed anyway and the failure recorded — a marker that
# survives a failed attempt would make every future boot retry it, which is a
# boot loop in exchange for a problem that needs a human.
set -eu
mkdir -p /app/data /app/data/db /app/data/redis /app/data-home
chown -R node:node /app/data /app/data-home 2>/dev/null || true

BACKUP_DIR=/app/data/db/backup
MARKER="$BACKUP_DIR/restore-pending.json"
DB=/app/data/db/data.sqlite

if [ -f "$MARKER" ]; then
  STAGED="$(sed -n 's/.*"stagedFile"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$MARKER" | head -1)"
  echo "[entrypoint] restore requested; staged file: ${STAGED:-<unreadable>}"
  if [ -n "${STAGED:-}" ] && [ -f "$STAGED" ]; then
    # Keep the pre-restore database. The whole point of a restore is to recover
    # from something; a second mistake should not be unrecoverable too.
    if [ -f "$DB" ]; then
      cp -a "$DB" "$BACKUP_DIR/pre-restore-$(date '+%Y%m%d-%H%M%S').sqlite" 2>/dev/null || true
    fi
    # WAL/SHM belong to the OLD database. Leaving them next to a replaced main
    # file is what silently corrupts a database, so they go first.
    rm -f "${DB}-wal" "${DB}-shm"
    if cp -a "$STAGED" "$DB"; then
      echo "[entrypoint] database replaced from staged restore"
      rm -f "$STAGED"
    else
      echo "[entrypoint] ERROR: could not replace database; keeping original"
    fi
  else
    echo "[entrypoint] ERROR: staged restore file missing; nothing replaced"
  fi
  rm -f "$MARKER"
  chown -R node:node /app/data 2>/dev/null || true
fi

exec su-exec node "$@"
