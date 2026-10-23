#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
cd "$REPO"
export SMOKE_PORT=8079 MOCK_PORT=9079
NODE_BIN="$(command -v "${SMOKE_NODE:-node}")"
command -v lsof >/dev/null || { printf 'lsof is required for safe port ownership checks.\n' >&2; exit 1; }
command -v curl >/dev/null || { printf 'curl is required for readiness checks.\n' >&2; exit 1; }
for port in "$SMOKE_PORT" "$MOCK_PORT"; do
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    printf 'CodeBuddy check-in fixture port %s is occupied. Reuse an existing healthy fixture or explicitly stop its owner; no process was stopped.\n' "$port" >&2
    exit 1
  fi
done
FIXTURE_DIR="$(mktemp -d /tmp/sm-codebuddy-checkin.XXXXXX)"
export DATA_DIR="$FIXTURE_DIR/data" HOME="$FIXTURE_DIR/home"
mkdir -p "$DATA_DIR" "$HOME"
export JWT_SECRET="fixture-not-real" INITIAL_PASSWORD="fixture-password" API_KEY_SECRET="fixture-not-real" MACHINE_ID_SALT="fixture-salt"
export NEXT_DIST_DIR=".next-preview/$(basename "$FIXTURE_DIR")" NEXT_TELEMETRY_DISABLED=1
export NEXT_PUBLIC_BASE_URL="http://127.0.0.1:$SMOKE_PORT" PORT="$SMOKE_PORT"
export SPRING_MOUSE_REDIS_URL="" SPRING_MOUSE_REDIS_REQUIRED=false
# Replace host preloads rather than inheriting them; Next workers inherit this guard.
export NODE_OPTIONS="--require \"$HERE/preload.cjs\""
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
  local pid="$1" url="$2" attempts="$3" label="$4" i
  for ((i=0; i<attempts; i++)); do
    kill -0 "$pid" 2>/dev/null || { printf '%s exited before readiness\n' "$label" >&2; return 1; }
    if curl --noproxy '*' --max-time 3 -fsS "$url" >/dev/null 2>&1; then return 0; fi
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
printf 'CodeBuddy check-in fixture ready: http://127.0.0.1:%s/dashboard/providers/codebuddy-cn\nMock requests (no auth): http://127.0.0.1:%s/requests\nIsolated DATA_DIR: %s\nIsolated HOME: %s\nBuild output: %s/%s\n' "$SMOKE_PORT" "$MOCK_PORT" "$DATA_DIR" "$HOME" "$REPO" "$NEXT_DIST_DIR"
# Host bootstrap (including background schedulers) stays disabled intentionally.
# Browser tests drive the check-in UI; no verify script or real account is used.
while kill -0 "${pids[0]}" 2>/dev/null && kill -0 "${pids[1]}" 2>/dev/null; do sleep 2; done
printf 'A fixture service exited; stopping fixture children.\n' >&2
exit 1
