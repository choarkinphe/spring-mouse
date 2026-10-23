#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
cd "$REPO"
export SMOKE_PORT=8083
if lsof -nP -iTCP:"$SMOKE_PORT" -sTCP:LISTEN >/dev/null 2>&1; then printf 'Port %s is occupied; no process was stopped.\n' "$SMOKE_PORT" >&2; exit 1; fi
FIXTURE_DIR="$(mktemp -d /tmp/sm-workbuddy.XXXXXX)"
export DATA_DIR="$FIXTURE_DIR/data" HOME="$FIXTURE_DIR/home"
mkdir -p "$DATA_DIR" "$HOME"
export JWT_SECRET="fixture-not-real" INITIAL_PASSWORD="fixture-password" API_KEY_SECRET="fixture-not-real" MACHINE_ID_SALT="fixture-salt"
export NEXT_DIST_DIR=".next-preview/$(basename "$FIXTURE_DIR")" NEXT_TELEMETRY_DISABLED=1
export NEXT_PUBLIC_BASE_URL="http://127.0.0.1:$SMOKE_PORT" PORT="$SMOKE_PORT"
export SPRING_MOUSE_REDIS_URL="" SPRING_MOUSE_REDIS_REQUIRED=false
export NODE_OPTIONS="--require $HERE/preload.cjs"
node --import "$REPO/tests/fixtures/claude-desktop-smoke/register.mjs" "$HERE/seed.mjs"
node "$REPO/node_modules/next/dist/bin/next" dev --turbopack --hostname 127.0.0.1 --port "$SMOKE_PORT" &
pid=$!
stop_tree() { local child; for child in $(pgrep -P "$1" 2>/dev/null || true); do stop_tree "$child"; done; kill "$1" 2>/dev/null || true; }
cleanup() { stop_tree "$pid"; wait "$pid" 2>/dev/null || true; }
trap cleanup EXIT
trap 'exit 0' INT TERM
for _ in $(seq 1 120); do
  kill -0 "$pid" 2>/dev/null || exit 1
  if curl --noproxy '*' --max-time 3 -fsS "http://127.0.0.1:$SMOKE_PORT/api/health" >/dev/null 2>&1; then
    printf 'WorkBuddy fixture ready: http://127.0.0.1:%s/dashboard/providers (isolated %s)\n' "$SMOKE_PORT" "$FIXTURE_DIR"
    wait "$pid"
    exit $?
  fi
  sleep 1
done
printf 'WorkBuddy fixture readiness failed\n' >&2
exit 1
