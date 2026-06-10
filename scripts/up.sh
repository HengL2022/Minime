#!/bin/bash
# Start Postgres + check Ollama for daily use. For first-time setup use scripts/install.sh,
# which installs anything missing; this script only starts what is already installed.
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck source=scripts/lib.sh
. scripts/lib.sh

if docker_available; then
  echo "==> Starting Postgres via Docker Compose"
  MINIME_PG_PORT="$PG_PORT" docker compose up -d --wait
  super_psql() { docker compose exec -T db psql -U minime -d "$1" "${@:2}"; }
  ensure_pg_objects
elif is_macos; then
  echo "==> Docker not available; using Homebrew postgresql@17"
  have brew || { echo "Neither Docker nor Homebrew found. Run: bash scripts/install.sh" >&2; exit 1; }
  PGPREFIX="$(brew --prefix postgresql@17 2>/dev/null)" || PGPREFIX=""
  PGBIN="$PGPREFIX/bin"
  if [ -z "$PGPREFIX" ] || [ ! -x "$PGBIN/pg_isready" ]; then
    echo "postgresql@17 not installed. Run: bash scripts/install.sh (or: brew install postgresql@17 pgvector)" >&2
    exit 1
  fi
  if ! "$PGBIN/pg_isready" -h localhost -p "$PG_PORT" -q; then
    brew services start postgresql@17
    wait_pg_ready "$PGBIN/pg_isready" || { echo "Postgres failed to start" >&2; exit 1; }
  fi
  super_psql() { "$PGBIN/psql" -h localhost -p "$PG_PORT" -d "$1" "${@:2}"; }
  ensure_pg_objects
  echo "==> Postgres ready on localhost:$PG_PORT (databases: minime, minime_test)"
elif is_debianish; then
  echo "==> Docker not available; using system PostgreSQL 16"
  SUDO=""
  [ "$(id -u)" = 0 ] || SUDO="sudo -n"
  FOUND_PORT="$(linux_pg16_port)"
  [ -n "$FOUND_PORT" ] && PG_PORT="$FOUND_PORT"
  if has_systemd; then
    $SUDO systemctl start "postgresql@16-main" 2>/dev/null || $SUDO systemctl start postgresql 2>/dev/null || true
  else
    $SUDO pg_ctlcluster 16 main start 2>/dev/null || true
  fi
  wait_pg_ready || { echo "Postgres not ready on :$PG_PORT. Run: bash scripts/install.sh" >&2; exit 1; }
  super_psql() { $SUDO -u postgres psql -p "$PG_PORT" -d "$1" "${@:2}"; }
  ensure_pg_objects
  echo "==> Postgres ready on localhost:$PG_PORT (databases: minime, minime_test)"
else
  echo "Unsupported platform; run: bash scripts/install.sh" >&2
  exit 1
fi

# --- Ollama check (advisory; CI/tests mock Ollama) ---
if ollama_reachable; then
  for model in "$EMBED_MODEL" "$CLASSIFY_MODEL"; do
    if ollama_has_model "$model"; then
      echo "==> Ollama model present: $model"
    else
      echo "WARNING: Ollama model missing: $model  (run: ollama pull $model)" >&2
    fi
  done
else
  echo "WARNING: Ollama not reachable at $OLLAMA_URL (embeddings/classification unavailable; tests still run mocked)" >&2
fi
echo "==> up complete"
