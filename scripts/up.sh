#!/bin/bash
# Start Postgres + check Ollama for daily use. For first-time setup use scripts/install.sh,
# which installs anything missing; this script only starts what is already installed.
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck source=scripts/lib.sh
. scripts/lib.sh

if ! ollama_preflight; then
  echo "ERROR: $(ollama_preflight_error)." >&2
  echo "FIX: $(ollama_preflight_fix)." >&2
  exit 40
fi

[ -f .env ] || {
  echo "ERROR: .env is required before starting an installed PostgreSQL backend." >&2
  echo "FIX: run bash scripts/install.sh first." >&2
  exit 40
}

if ! resolve_pg_lifecycle .env 0; then
  echo "ERROR: Postgres lifecycle state is invalid ($PG_STATE_RULE)." >&2
  echo "FIX: set a loopback DATABASE_URL for database minime plus MINIME_PG_BACKEND=native|docker and MINIME_PG_PORT=<1-65535> in .env, then retry." >&2
  exit 40
fi

if [ "$PG_INSTALL_PENDING" = 1 ]; then
  echo "ERROR: PostgreSQL installation is incomplete." >&2
  echo "FIX: resume with bash scripts/install.sh; daily start will not complete bootstrap." >&2
  exit 40
fi

if [ "$PG_BACKEND" = docker ]; then
  docker_available || {
    echo "ERROR: persisted Docker backend is unavailable." >&2
    echo "FIX: start/install Docker, then retry; Minime will not switch the persisted backend." >&2
    exit 22
  }
  echo "==> Starting Postgres via Docker Compose"
  MINIME_PG_PORT="$PG_PORT" docker compose up -d --wait
  selected_pg_backend_matches_service || {
    echo "ERROR: started Docker service identity does not match persisted lifecycle state." >&2
    exit 20
  }
  pg_owner_reachable || {
    echo "ERROR: exact persisted owner credentials failed before Docker bootstrap." >&2
    echo "FIX: repair DATABASE_URL in .env; no bootstrap SQL was applied." >&2
    exit 21
  }
  super_psql() { docker compose exec -T db psql -U minime -d "$1" "${@:2}"; }
  ensure_pg_objects
elif is_macos; then
  echo "==> Starting persisted Homebrew postgresql@17 backend"
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
  selected_pg_backend_matches_service || {
    echo "ERROR: started Homebrew PostgreSQL identity does not match persisted lifecycle state." >&2
    exit 20
  }
  pg_owner_reachable || {
    echo "ERROR: exact persisted owner credentials failed before Homebrew bootstrap." >&2
    echo "FIX: repair DATABASE_URL in .env; no bootstrap SQL was applied." >&2
    exit 21
  }
  super_psql() { "$PGBIN/psql" -h localhost -p "$PG_PORT" -d "$1" "${@:2}"; }
  ensure_pg_objects
  echo "==> Postgres ready on localhost:$PG_PORT (databases: minime, minime_test)"
elif is_debianish; then
  echo "==> Starting persisted system PostgreSQL 16 backend"
  SUDO=""
  [ "$(id -u)" = 0 ] || SUDO="sudo -n"
  FOUND_PORT="$(linux_pg16_port)"
  [ "$FOUND_PORT" = "$PG_PORT" ] || {
    echo "PostgreSQL 16/main port does not match persisted MINIME_PG_PORT. Run: bash scripts/install.sh" >&2
    exit 1
  }
  if has_systemd; then
    $SUDO systemctl start "postgresql@16-main" 2>/dev/null ||
      $SUDO pg_ctlcluster 16 main start 2>/dev/null || true
  else
    $SUDO pg_ctlcluster 16 main start 2>/dev/null || true
  fi
  wait_pg_ready || { echo "Postgres not ready on :$PG_PORT. Run: bash scripts/install.sh" >&2; exit 1; }
  selected_pg_backend_matches_service || {
    echo "ERROR: started PostgreSQL 16/main identity does not match persisted lifecycle state." >&2
    exit 20
  }
  pg_owner_reachable || {
    echo "ERROR: exact persisted owner credentials failed before PostgreSQL bootstrap." >&2
    echo "FIX: repair DATABASE_URL in .env; no bootstrap SQL was applied." >&2
    exit 21
  }
  super_psql() { $SUDO -u postgres psql -p "$PG_PORT" -d "$1" "${@:2}"; }
  ensure_pg_objects
  echo "==> Postgres ready on localhost:$PG_PORT (databases: minime, minime_test)"
else
  echo "Unsupported platform; run: bash scripts/install.sh" >&2
  exit 1
fi

selected_pg_backend_matches_service || {
  echo "ERROR: selected PostgreSQL backend identity does not match the persisted port." >&2
  echo "FIX: align the actual service with MINIME_PG_BACKEND and MINIME_PG_PORT, then retry." >&2
  exit 20
}
pg_bootstrap_complete || {
  echo "ERROR: exact configured DATABASE_URL probe failed after Postgres startup." >&2
  echo "FIX: check the persisted local credentials/backend/port, then run bash scripts/install.sh." >&2
  exit 20
}
if [ "$PG_STATE_NEEDS_PERSIST" = 1 ] && [ -f .env ]; then
  persist_pg_lifecycle .env 0 || {
    echo "ERROR: could not persist PostgreSQL lifecycle state." >&2
    echo "FIX: check .env permissions, then retry." >&2
    exit 40
  }
fi

# --- Ollama check (advisory; CI/tests mock Ollama) ---
if ollama_reachable; then
  for model in "$EMBED_MODEL" "$CLASSIFY_MODEL"; do
    if ollama_has_model "$model"; then
      echo "==> Ollama model present: $model"
    else
      echo "WARNING: Ollama model missing: $model  (run: bash scripts/install.sh)" >&2
    fi
  done
else
  echo "WARNING: Ollama not reachable (embeddings/classification unavailable; tests still run mocked)" >&2
fi
echo "==> up complete"
