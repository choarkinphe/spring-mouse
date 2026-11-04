#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
cd "$REPO"
PORT=8087
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  printf 'Credit fixture port %s is occupied; no process was stopped.\n' "$PORT" >&2
  exit 1
fi
NODE_BIN="$(command -v node)"
FIXTURE_DIR="$(mktemp -d /tmp/sm-qoder-credits.XXXXXX)"
export DATA_DIR="$FIXTURE_DIR/data" HOME="$FIXTURE_DIR/home"
mkdir -p "$DATA_DIR" "$HOME"
export JWT_SECRET="fixture-not-real" INITIAL_PASSWORD="fixture-password" API_KEY_SECRET="fixture-not-real" MACHINE_ID_SALT="fixture-salt"
export NEXT_DIST_DIR=".next-preview/$(basename "$FIXTURE_DIR")" NEXT_TELEMETRY_DISABLED=1
export NEXT_PUBLIC_BASE_URL="http://127.0.0.1:$PORT" PORT
export SPRING_MOUSE_REDIS_URL="" SPRING_MOUSE_REDIS_REQUIRED=false
export NODE_OPTIONS="--require \"$HERE/preload.cjs\""
pid=''
stop_child_tree() {
  local target="$1" child
  kill -0 "$target" 2>/dev/null || return 0
  for child in $(pgrep -P "$target" 2>/dev/null || true); do stop_child_tree "$child"; done
  kill "$target" 2>/dev/null || true
}
cleanup() { if [ -n "$pid" ]; then stop_child_tree "$pid"; wait "$pid" 2>/dev/null || true; fi; }
trap cleanup EXIT
trap 'exit 0' INT TERM
"$NODE_BIN" --import "$REPO/tests/fixtures/claude-desktop-smoke/register.mjs" "$HERE/seed.mjs"
"$NODE_BIN" "$REPO/node_modules/next/dist/bin/next" dev --turbopack --hostname 127.0.0.1 --port "$PORT" &
pid=$!
ready=false
for ((i=0; i<120; i++)); do
  kill -0 "$pid" 2>/dev/null || { printf 'Gateway exited before readiness\n' >&2; exit 1; }
  if curl --noproxy '*' --max-time 3 -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then ready=true; break; fi
  sleep 1
done
[ "$ready" = true ] || { printf 'Gateway readiness failed\n' >&2; exit 1; }
printf 'Credit fixture ready: http://127.0.0.1:%s/dashboard/providers?channel=qoder\nIsolated data: %s\n' "$PORT" "$FIXTURE_DIR"
wait "$pid"
