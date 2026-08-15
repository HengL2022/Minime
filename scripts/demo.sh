#!/usr/bin/env bash
# Isolated fictional demo stack. Never reads or writes .env, data/, or the
# live compose volume. Uses the committed compose defaults on loopback:5433.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
COMPOSE=(docker compose -f "$ROOT/docker-compose.demo.yml" -p minime-demo)
DEMO_URL="postgres://minime:minime@127.0.0.1:5433/minime"
# Published fictional demo password — not an owner secret. Length matches the
# provisioner charset so `serve` can use a distinct minime_app DSN.
DEMO_APP_PASSWORD="minime_demo_app_password_ok"

die() {
  echo "ERROR: $1" >&2
  echo "FIX: $2" >&2
  exit "${3:-1}"
}

demo_app_url() {
  DATABASE_URL="$DEMO_URL" MINIME_APP_PASSWORD="$DEMO_APP_PASSWORD" \
    bun --no-env-file -e 'import { derivePostgresCredentials } from "./src/util/postgres-url"; console.log(derivePostgresCredentials(process.env.DATABASE_URL, "minime_app", process.env.MINIME_APP_PASSWORD, "minime"))'
}

# Isolate from a live repo .env. A leftover MINIME_APP_DATABASE_URL on another
# port would fail validateMinimeDatabasePair at module load.
demo_env() {
  export MINIME_SKIP_REPO_DOTENV=1
  export DATABASE_URL="$DEMO_URL"
  export MINIME_APP_PASSWORD="$DEMO_APP_PASSWORD"
  export MINIME_APP_DATABASE_URL
  MINIME_APP_DATABASE_URL="$(demo_app_url)"
  export MINIME_DATA_DIR="${MINIME_DATA_DIR:-$ROOT/data/demo}"
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
      demo_env
      bun --no-env-file run src/cli.ts migrate --context direct
      bun --no-env-file run src/cli.ts seed
      bun --no-env-file run scripts/provision-runtime-role.ts
    )
    APP_URL="$(cd "$ROOT" && demo_app_url)"
    echo "==== MINIME DEMO ===="
    echo "status: ready"
    echo "postgres: docker minime-demo-db @ 127.0.0.1:5433"
    echo "demo: seeded (fictional)"
    echo "mcp: MINIME_SKIP_REPO_DOTENV=1 DATABASE_URL=$DEMO_URL MINIME_APP_DATABASE_URL=$APP_URL MINIME_DATA_DIR=$ROOT/data/demo bun run $ROOT/src/cli.ts serve"
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
