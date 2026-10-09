#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
cd "$REPO"
export SMOKE_PORT="${SMOKE_PORT:-8027}" MOCK_PORT="${MOCK_PORT:-9027}"
NODE_BIN="${SMOKE_NODE:-node}"
for port in "$SMOKE_PORT" "$MOCK_PORT"; do
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    printf 'Port %s is already occupied; no process will be stopped.\n' "$port" >&2
    exit 1
  fi
done
SMOKE_DIR="$(mktemp -d /tmp/sm-capability.XXXXXX)"
export DATA_DIR="$SMOKE_DIR/data" HOME="$SMOKE_DIR/home"
mkdir -p "$DATA_DIR" "$HOME"
export JWT_SECRET="fixture-not-real" INITIAL_PASSWORD="fixture-password" API_KEY_SECRET="fixture-not-real" MACHINE_ID_SALT="fixture-salt"
export NEXT_DIST_DIR=".next-capability-preview" NEXT_TELEMETRY_DISABLED=1
export SPRING_MOUSE_REDIS_URL="" SPRING_MOUSE_REDIS_REQUIRED=false
export NODE_OPTIONS="--require $REPO/tests/fixtures/claude-desktop-smoke/preload.cjs"
pids=()
cleanup() { for pid in "${pids[@]}"; do kill "$pid" 2>/dev/null || true; done; wait 2>/dev/null || true; }
trap cleanup EXIT
trap 'exit 0' INT TERM
"$NODE_BIN" "$HERE/mock-upstream.mjs" &
pids+=($!)
ready=false
for _ in $(seq 1 20); do
  kill -0 "${pids[0]}" 2>/dev/null || exit 1
  if curl -fsS "http://127.0.0.1:$MOCK_PORT/models" >/dev/null 2>&1; then ready=true; break; fi
  sleep 1
done
if [ "$ready" != true ]; then printf 'Mock readiness failed\n' >&2; exit 1; fi
"$NODE_BIN" --import "$REPO/tests/fixtures/claude-desktop-smoke/register.mjs" "$HERE/seed.mjs"
"$NODE_BIN" "$REPO/node_modules/next/dist/bin/next" dev --turbopack --hostname 127.0.0.1 --port "$SMOKE_PORT" &
pids+=($!)
ready=false
for _ in $(seq 1 120); do
  kill -0 "${pids[1]}" 2>/dev/null || exit 1
  if curl -fsS "http://127.0.0.1:$SMOKE_PORT/api/health" >/dev/null 2>&1; then ready=true; break; fi
  sleep 1
done
if [ "$ready" != true ]; then printf 'Gateway readiness failed\n' >&2; exit 1; fi
"$NODE_BIN" "$HERE/verify.mjs"
printf 'Capability fixture verified: http://127.0.0.1:%s/dashboard/providers?channel=openai-compatible-chat-capability-fixture (isolated data: %s)\n' "$SMOKE_PORT" "$DATA_DIR"
wait
