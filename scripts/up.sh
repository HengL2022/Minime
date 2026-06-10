#!/bin/bash
# Start Postgres + verify Ollama. Prefers Docker (spec §4); falls back to Homebrew
# postgresql@17 + pgvector on boxes without Docker (see DECISIONS.md).
set -euo pipefail
cd "$(dirname "$0")/.."

if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  echo "==> Starting Postgres via Docker Compose"
  docker compose up -d --wait
else
  echo "==> Docker not available; using Homebrew postgresql@17"
  PGPREFIX="$(brew --prefix postgresql@17)"
  PGBIN="$PGPREFIX/bin"
  if [ ! -x "$PGBIN/pg_isready" ]; then
    echo "postgresql@17 not installed. Run: brew install postgresql@17 pgvector" >&2
    exit 1
  fi
  if ! "$PGBIN/pg_isready" -h localhost -p 5432 -q; then
    brew services start postgresql@17
    for _ in $(seq 1 30); do
      "$PGBIN/pg_isready" -h localhost -p 5432 -q && break
      sleep 1
    done
  fi
  "$PGBIN/pg_isready" -h localhost -p 5432 -q || { echo "Postgres failed to start" >&2; exit 1; }
  # Idempotent bootstrap: app role + databases + trusted extensions.
  "$PGBIN/psql" -h localhost -p 5432 -d postgres -v ON_ERROR_STOP=1 -qAt <<'SQL'
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'minime') then
    create role minime login password 'minime' createdb createrole;
  else
    alter role minime createdb createrole;
  end if;
end $$;
SQL
  for db in minime minime_test; do
    if ! "$PGBIN/psql" -h localhost -p 5432 -d postgres -qAt -c "select 1 from pg_database where datname='$db'" | grep -q 1; then
      "$PGBIN/createdb" -h localhost -p 5432 -O minime "$db"
    fi
    "$PGBIN/psql" -h localhost -p 5432 -d "$db" -v ON_ERROR_STOP=1 -q \
      -c "create extension if not exists vector; create extension if not exists pgcrypto;"
  done
  echo "==> Postgres ready on localhost:5432 (databases: minime, minime_test)"
fi

# --- Ollama check (advisory; CI/tests mock Ollama) ---
OLLAMA_URL="${OLLAMA_URL:-http://localhost:11434}"
EMBED_MODEL="${EMBED_MODEL:-nomic-embed-text}"
CLASSIFY_MODEL="${CLASSIFY_MODEL:-llama3.1:8b}"
if curl -fsS -m 3 "$OLLAMA_URL/api/tags" -o /tmp/minime-ollama-tags.json 2>/dev/null; then
  for model in "$EMBED_MODEL" "$CLASSIFY_MODEL"; do
    if grep -q "\"$model" /tmp/minime-ollama-tags.json; then
      echo "==> Ollama model present: $model"
    else
      echo "WARNING: Ollama model missing: $model  (run: ollama pull $model)" >&2
    fi
  done
else
  echo "WARNING: Ollama not reachable at $OLLAMA_URL (embeddings/classification unavailable; tests still run mocked)" >&2
fi
echo "==> up complete"
