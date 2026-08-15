#!/usr/bin/env bash
# Isolated fictional demo stack. Never reads or writes .env, data/, or the
# live compose volume. Uses the committed compose defaults on loopback:5433.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
COMPOSE=(docker compose -f "$ROOT/docker-compose.demo.yml" -p minime-demo)
DEMO_URL="postgres://minime:minime@127.0.0.1:5433/minime"

die() {
  echo "ERROR: $1" >&2
  echo "FIX: $2" >&2
  exit "${3:-1}"
}

wait_ready() {
  local i
  for i in $(seq 1 30); do
    if docker exec minime-demo-db pg_isready -U minime >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  die "demo Postgres did not become ready" "docker compose -f docker-compose.demo.yml -p minime-demo logs"
}

case "${1:-up}" in
  up)
    command -v docker >/dev/null || die "docker is required for the isolated demo" "install Docker, or use bash scripts/install.sh --with-demo"
    "${COMPOSE[@]}" up -d
    wait_ready
    (
      cd "$ROOT"
      DATABASE_URL="$DEMO_URL" bun --no-env-file run src/cli.ts migrate --context direct
      DATABASE_URL="$DEMO_URL" bun --no-env-file run src/cli.ts seed
    )
    echo "==== MINIME DEMO ===="
    echo "status: ready"
    echo "postgres: docker minime-demo-db @ 127.0.0.1:5433"
    echo "demo: seeded (fictional)"
    echo "mcp: DATABASE_URL=$DEMO_URL bun run $ROOT/src/cli.ts serve"
    echo "stop: make demo-down"
    echo "====================="
    ;;
  down)
    "${COMPOSE[@]}" down
    echo "demo stack stopped (volume kept; add -v to wipe)"
    ;;
  *)
    die "unknown demo action" "make demo   or   make demo-down"
    ;;
esac
