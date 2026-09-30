#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
cd "$REPO"
export SMOKE_PORT="${SMOKE_PORT:-8017}" MOCK_PORT="${MOCK_PORT:-9017}"
NODE_BIN="${SMOKE_NODE:-node}"
SMOKE_DIR="$(mktemp -d /tmp/sm-smoke.XXXXXX)"
export DATA_DIR="$SMOKE_DIR/data" HOME="$SMOKE_DIR/home"
mkdir -p "$DATA_DIR" "$HOME"
export JWT_SECRET="smoke-jwt-not-real" INITIAL_PASSWORD="smoke-password" API_KEY_SECRET="smoke-api-not-real" MACHINE_ID_SALT="smoke-salt"
export NEXT_DIST_DIR=".next-preview" NEXT_TELEMETRY_DISABLED=1
export SPRING_MOUSE_REDIS_URL="" SPRING_MOUSE_REDIS_REQUIRED=false
export NODE_OPTIONS="--require $HERE/preload.cjs"
pids=()
cleanup() {
  for pid in "${pids[@]}"; do kill "$pid" 2>/dev/null || true; done
  wait 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 0' INT TERM
"$NODE_BIN" "$HERE/mock-upstream.mjs" &
pids+=($!)
mock_ready=false
for _ in $(seq 1 20); do
  kill -0 "${pids[0]}" 2>/dev/null || exit 1
  if curl -fsS "http://127.0.0.1:$MOCK_PORT/models" >/dev/null 2>&1; then mock_ready=true; break; fi
  sleep 1
 done
if [ "$mock_ready" != true ]; then printf 'Mock readiness timed out\n' >&2; exit 1; fi
"$NODE_BIN" --import "$HERE/register.mjs" "$HERE/seed.mjs"
"$NODE_BIN" "$REPO/node_modules/next/dist/bin/next" dev --turbopack --hostname 127.0.0.1 --port "$SMOKE_PORT" &
pids+=($!)
ready=false
for _ in $(seq 1 120); do
  if curl -fsS "http://127.0.0.1:$SMOKE_PORT/api/health" >/dev/null 2>&1; then ready=true; break; fi
  kill -0 "${pids[1]}" 2>/dev/null || exit 1
  sleep 1
done
if [ "$ready" != true ]; then printf 'Server readiness timed out\n' >&2; exit 1; fi
"$NODE_BIN" "$HERE/verify.mjs"
printf '[smoke] verified; gateway http://127.0.0.1:%s; isolated data %s\n' "$SMOKE_PORT" "$DATA_DIR"
wait
