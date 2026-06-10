# shellcheck shell=bash
# Shared helpers for scripts/up.sh and scripts/install.sh. Source, don't execute.

PG_PORT="${MINIME_PG_PORT:-5432}"
OLLAMA_URL="${OLLAMA_URL:-http://localhost:11434}"
EMBED_MODEL="${EMBED_MODEL:-nomic-embed-text}"
CLASSIFY_MODEL="${CLASSIFY_MODEL:-llama3.1:8b}"

have() { command -v "$1" >/dev/null 2>&1; }
is_macos() { [ "$(uname -s)" = "Darwin" ]; }
is_debianish() { [ -f /etc/debian_version ]; }
has_systemd() { [ -d /run/systemd/system ]; }

docker_available() { have docker && docker info >/dev/null 2>&1; }

# Something (anything) listening on 127.0.0.1:$1? Pure bash, no nc/psql needed.
port_open() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null && exec 3>&- 3<&-; }

# Minime's own Postgres reachable with pgvector? Needs bun + node_modules (cheap, no psql).
pg_provisioned() {
  have bun && [ -d node_modules/postgres ] &&
    PROBE_URL="postgres://minime:minime@localhost:$PG_PORT/minime" bun scripts/pg-probe.ts >/dev/null 2>&1
}

wait_pg_ready() { # $1 = pg_isready path (default: from PATH)
  local bin="${1:-pg_isready}" _
  for _ in $(seq 1 60); do
    "$bin" -h 127.0.0.1 -p "$PG_PORT" -q 2>/dev/null && return 0
    sleep 1
  done
  return 1
}

# Role + databases + extensions, idempotent. Caller must define:
#   super_psql <dbname> [psql args...]  — run psql as a superuser against <dbname>.
ensure_pg_objects() {
  super_psql postgres -v ON_ERROR_STOP=1 -qAt <<'SQL'
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'minime') then
    create role minime login password 'minime' createdb createrole;
  else
    alter role minime createdb createrole;
  end if;
end $$;
SQL
  local db
  for db in minime minime_test; do
    if ! super_psql postgres -qAt -c "select 1 from pg_database where datname='$db'" | grep -q 1; then
      super_psql postgres -qAt -c "create database $db owner minime" >/dev/null
    fi
    super_psql "$db" -v ON_ERROR_STOP=1 -qAt \
      -c "create extension if not exists vector; create extension if not exists pgcrypto;" >/dev/null
  done
}

ollama_reachable() { curl -fsS -m 3 "$OLLAMA_URL/api/tags" >/dev/null 2>&1; }

# Exact-match a model name against /api/tags JSON ("name":"X" or "name":"X:tag").
ollama_has_model() {
  local model="$1" tags
  tags=$(curl -fsS -m 3 "$OLLAMA_URL/api/tags" 2>/dev/null) || return 1
  printf '%s' "$tags" | grep -Eq "\"name\":\"${model}(:[^\"]*)?\""
}

# Debian/Ubuntu: ensure the PGDG apt repo (distro archives lack pgvector or ship old PG).
# Caller provides $SUDO ("" when root). Idempotent via the sources-list file.
ensure_pgdg_repo() {
  [ -f /etc/apt/sources.list.d/pgdg.list ] && return 0
  $SUDO apt-get update -qq
  DEBIAN_FRONTEND=noninteractive $SUDO apt-get install -y -qq curl ca-certificates gnupg >/dev/null
  $SUDO install -d -m 0755 /usr/share/postgresql-common/pgdg
  $SUDO curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc \
    -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc
  # shellcheck disable=SC1091
  . /etc/os-release
  echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt ${VERSION_CODENAME}-pgdg main" |
    $SUDO tee /etc/apt/sources.list.d/pgdg.list >/dev/null
  $SUDO apt-get update -qq
}

# Debian assigns the next free port when 5432 is taken — discover where 16/main landed.
linux_pg16_port() {
  pg_lsclusters -h 2>/dev/null | awk '$1==16 && $2=="main" {print $3; exit}'
}
