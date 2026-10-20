#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
cd "$REPO"
export SMOKE_PORT="${SMOKE_PORT:-8067}" MOCK_PORT="${MOCK_PORT:-9067}"
NODE_BIN="$(command -v "${SMOKE_NODE:-node}")"
for port in "$SMOKE_PORT" "$MOCK_PORT"; do
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    printf 'Combo-search fixture port %s is occupied. Reuse the existing preview if healthy, or stop its owner explicitly; no process was stopped.\n' "$port" >&2
    exit 1
  fi
done
FIXTURE_DIR="$(mktemp -d /tmp/sm-combo-search.XXXXXX)"
export DATA_DIR="$FIXTURE_DIR/data" HOME="$FIXTURE_DIR/home"
mkdir -p "$DATA_DIR" "$HOME"
export JWT_SECRET="fixture-not-real" INITIAL_PASSWORD="fixture-password" API_KEY_SECRET="fixture-not-real" MACHINE_ID_SALT="fixture-salt"
# Unique and inside the project, under its existing ignored preview directory.
export NEXT_DIST_DIR=".next-preview/$(basename "$FIXTURE_DIR")" NEXT_TELEMETRY_DISABLED=1
export NEXT_PUBLIC_BASE_URL="http://127.0.0.1:$SMOKE_PORT" PORT="$SMOKE_PORT"
export SPRING_MOUSE_REDIS_URL="" SPRING_MOUSE_REDIS_REQUIRED=false
# Replace, rather than inherit, host preloads. Guard applies to Next child workers too.
export NODE_OPTIONS="--require $HERE/preload.cjs"
pids=()
stop_child_tree() {
  local pid="$1" child
  kill -0 "$pid" 2>/dev/null || return 0
  for child in $(pgrep -P "$pid" 2>/dev/null || true); do stop_child_tree "$child"; done
  kill "$pid" 2>/dev/null || true
}
cleanup() {
  for pid in "${pids[@]}"; do stop_child_tree "$pid"; done
  wait 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 0' INT TERM
wait_ready() {
  local pid="$1" url="$2" attempts="$3" label="$4"
  for ((i=0; i<attempts; i++)); do
    kill -0 "$pid" 2>/dev/null || { printf '%s exited before readiness\n' "$label" >&2; return 1; }
    if curl --max-time 3 -fsS "$url" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  printf '%s readiness failed: %s\n' "$label" "$url" >&2
  return 1
}
"$NODE_BIN" "$HERE/mock-upstream.mjs" &
pids+=($!)
wait_ready "${pids[0]}" "http://127.0.0.1:$MOCK_PORT/health" 20 Mock
"$NODE_BIN" --import "$REPO/tests/fixtures/claude-desktop-smoke/register.mjs" "$HERE/seed.mjs"
"$NODE_BIN" "$REPO/node_modules/next/dist/bin/next" dev --turbopack --hostname 127.0.0.1 --port "$SMOKE_PORT" &
pids+=($!)
wait_ready "${pids[1]}" "http://127.0.0.1:$SMOKE_PORT/api/health" 120 Gateway
"$NODE_BIN" "$HERE/verify.mjs"
printf 'Combo search fixture ready: http://127.0.0.1:%s/dashboard/combos\nMock: http://127.0.0.1:%s/requests\nIsolated DATA_DIR: %s\n' "$SMOKE_PORT" "$MOCK_PORT" "$DATA_DIR"
# Fail and clean up our other child if either service exits.
while kill -0 "${pids[0]}" 2>/dev/null && kill -0 "${pids[1]}" 2>/dev/null; do sleep 2; done
printf 'A fixture service exited; stopping fixture children.\n' >&2
exit 1
