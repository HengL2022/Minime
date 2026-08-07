#!/bin/bash
# One-command, non-interactive Minime installer for coding agents and humans.
#   bash scripts/install.sh [--with-demo] [--no-ollama] [--skip-verify] [--native] [--dry-run]
# Safe to re-run: every step detects before acting, and detection never needs privileges.
# Exit 0 = installed (status: ok | degraded — see the summary block). See AGENTS.md.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1
# shellcheck source=scripts/lib.sh
. scripts/lib.sh

USAGE="usage: bash scripts/install.sh [--with-demo] [--no-ollama] [--skip-verify] [--native] [--dry-run]"
WITH_DEMO=0 NO_OLLAMA=0 SKIP_VERIFY=0 FORCE_NATIVE=0 DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --with-demo) WITH_DEMO=1 ;;
    --no-ollama) NO_OLLAMA=1 ;;
    --skip-verify) SKIP_VERIFY=1 ;;
    --native) FORCE_NATIVE=1 ;;
    --dry-run) DRY_RUN=1 ;;
    *) echo "$USAGE" >&2; exit 2 ;;
  esac
done

PULL_TIMEOUT="${MINIME_PULL_TIMEOUT:-2400}"
PULL_MODELS="${MINIME_PULL_MODELS:-$EMBED_MODEL $CLASSIFY_MODEL}"
TOTAL=9
STEP=0
DEGRADED=0
SUMMARY_PG="" SUMMARY_OLLAMA="" SUMMARY_DEMO="not requested" SUMMARY_VERIFY="skipped"
ENV_CREATED_EARLY=0

line() { printf '[%d/%d] %-5s %s: %s\n' "$STEP" "$TOTAL" "$1" "$2" "$3"; }
note() { printf '      %s\n' "$*"; }
die() { # exit-code step-name error-sentence fix-command
  line FAIL "$2" "$3"
  echo "ERROR: $3"
  echo "FIX: $4"
  exit "$1"
}

INSTALL_LOCK_DIR="$PWD/.minime-install.lock"
release_install_lock() {
  local owner=""
  [ -d "$INSTALL_LOCK_DIR" ] && [ ! -L "$INSTALL_LOCK_DIR" ] || return 0
  owner="$(sed -n '1p' "$INSTALL_LOCK_DIR/pid" 2>/dev/null || true)"
  [ "$owner" = "$$" ] || return 0
  rm -f -- "$INSTALL_LOCK_DIR/pid" 2>/dev/null || return 0
  rmdir -- "$INSTALL_LOCK_DIR" 2>/dev/null || true
}
acquire_install_lock() {
  local owner="" stale="${INSTALL_LOCK_DIR}.stale.$$" attempt
  for attempt in 1 2 3; do
    if mkdir -- "$INSTALL_LOCK_DIR" 2>/dev/null; then
      printf '%s\n' "$$" > "$INSTALL_LOCK_DIR/pid" || {
        rmdir -- "$INSTALL_LOCK_DIR" 2>/dev/null || true
        return 1
      }
      chmod 700 "$INSTALL_LOCK_DIR" 2>/dev/null || { release_install_lock; return 1; }
      chmod 600 "$INSTALL_LOCK_DIR/pid" 2>/dev/null || { release_install_lock; return 1; }
      trap release_install_lock EXIT
      trap 'exit 129' HUP
      trap 'exit 130' INT
      trap 'exit 143' TERM
      return 0
    fi
    [ -d "$INSTALL_LOCK_DIR" ] && [ ! -L "$INSTALL_LOCK_DIR" ] || return 1
    owner="$(sed -n '1p' "$INSTALL_LOCK_DIR/pid" 2>/dev/null || true)"
    if ! [[ "$owner" =~ ^[1-9][0-9]*$ ]]; then
      sleep 1
      owner="$(sed -n '1p' "$INSTALL_LOCK_DIR/pid" 2>/dev/null || true)"
    fi
    if [[ "$owner" =~ ^[1-9][0-9]*$ ]] && kill -0 "$owner" 2>/dev/null; then return 1; fi
    mv -- "$INSTALL_LOCK_DIR" "$stale" 2>/dev/null || continue
    rm -f -- "$stale/pid" 2>/dev/null || return 1
    rmdir -- "$stale" 2>/dev/null || return 1
  done
  return 1
}

STEP=1
if ! ollama_preflight; then
  die 40 env "$(ollama_preflight_error)" "$(ollama_preflight_fix)"
fi

# --- sudo: resolved lazily, only when an install action actually needs it -----
SUDO="" SUDO_STATE=unresolved
resolve_sudo() {
  if [ "$SUDO_STATE" = unresolved ]; then
    if [ "$(id -u)" = 0 ]; then SUDO="" SUDO_STATE=ok
    elif have sudo && sudo -n true 2>/dev/null; then SUDO="sudo -n" SUDO_STATE=ok
    else SUDO_STATE=none
    fi
  fi
  [ "$SUDO_STATE" = ok ]
}

# --- platform ------------------------------------------------------------------
if is_macos; then OS_FAMILY=macos
elif is_debianish; then OS_FAMILY=debian
else
  echo "ERROR: unsupported platform $(uname -s) (supported: macOS, Debian/Ubuntu)"
  echo "FIX: install manually per README.md 'Manual install'"
  exit 3
fi

# =============================== 1. bun ========================================
STEP=1
export PATH="$HOME/.bun/bin:$PATH" # agents' shells don't re-source profiles
BUN_REQUIRED="$(pinned_bun_version)" ||
  die 10 bun "repository Bun pin is missing or invalid" \
    "restore .bun-version from Git, then re-run scripts/install.sh"
if pinned_bun_matches; then
  line SKIP bun "$BUN_REQUIRED already installed"
elif [ "$DRY_RUN" = 1 ]; then
  line OK bun "(dry-run) would install exact Bun $BUN_REQUIRED"
else
  if [ "$OS_FAMILY" = debian ] && ! have unzip; then # bun installer hard-requires unzip
    resolve_sudo && DEBIAN_FRONTEND=noninteractive $SUDO apt-get install -y -qq unzip >/dev/null 2>&1
  fi
  install_pinned_bun || die 10 bun "could not install exact Bun $BUN_REQUIRED" \
    "curl -fsSL https://bun.sh/install | bash -s -- bun-v$BUN_REQUIRED && export PATH=\"\$HOME/.bun/bin:\$PATH\", then re-run scripts/install.sh"
  line OK bun "installed $BUN_REQUIRED"
fi

# =============================== 2. deps =======================================
STEP=2
if [ -d node_modules/postgres ]; then
  line SKIP deps "node_modules already present"
elif [ "$DRY_RUN" = 1 ]; then
  line OK deps "(dry-run) would run bun install"
else
  bun install --frozen-lockfile >/dev/null 2>&1 ||
    die 11 deps "bun install failed" "bun install (to see full output), check network, then re-run"
  line OK deps "node_modules ready"
fi

if [ "$DRY_RUN" = 0 ]; then
  acquire_install_lock || die 40 env "another installer owns the lifecycle bootstrap lock" \
    "wait for it to finish; if no installer process remains, re-run to recover its stale lock"
fi

# Resolve an existing install's exact owner URL/backend/port before the first Postgres
# probe. Persisted .env state wins reruns; fresh --native/MINIME_PG_* choices are used
# only when there is no complete lifecycle state yet.
if ! resolve_pg_lifecycle .env "$FORCE_NATIVE" 1; then
  die 40 env "Postgres lifecycle state is invalid ($PG_STATE_RULE)" \
    "for a fresh install use the .env.example minime:minime owner URL; otherwise set the exact installed loopback DATABASE_URL plus MINIME_PG_BACKEND=native|docker and MINIME_PG_PORT=<1-65535>, then re-run"
fi

# =============================== 3. postgres ===================================
STEP=3
pg_detail() { SUMMARY_PG="$1"; line "$2" postgres "$1"; }

provision_docker() {
  MINIME_PG_PORT="$PG_PORT" docker compose up -d --wait >/dev/null 2>&1 || return 1
  selected_pg_backend_matches_service || return 1
  if [ "$PG_LIFECYCLE_FRESH" = 0 ] && [ "$PG_INSTALL_PENDING" = 0 ]; then
    pg_owner_reachable ||
      die 21 postgres "persisted owner credentials failed before Docker bootstrap" \
        "repair DATABASE_URL credentials in .env, then re-run; no bootstrap SQL was applied"
  fi
  super_psql() { docker compose exec -T db psql -U minime -d "$1" "${@:2}"; }
  ensure_pg_objects
}

provision_macos_native() {
  have brew || die 22 postgres "neither Docker nor Homebrew found" \
    "install Docker Desktop (docker.com) or Homebrew (brew.sh), then re-run scripts/install.sh"
  local pgprefix pgbin actual_port installed_new=0 brew_root data_dir
  pgprefix="$(brew --prefix postgresql@17 2>/dev/null)" || pgprefix=""
  if [ -z "$pgprefix" ] || [ ! -x "$pgprefix/bin/pg_isready" ]; then
    note "installing postgresql@17 + pgvector via Homebrew (a few minutes)"
    brew install -q postgresql@17 pgvector >/dev/null 2>&1 ||
      die 23 postgres "brew install postgresql@17 pgvector failed" "brew install postgresql@17 pgvector (to see why), then re-run"
    pgprefix="$(brew --prefix postgresql@17)"
    installed_new=1
  fi
  pgbin="$pgprefix/bin"
  actual_port="$(macos_native_pg_port 2>/dev/null || true)"
  if [ -n "$actual_port" ] && [ "$actual_port" != "$PG_PORT" ]; then
    if [ "$PG_PORT_EXPLICIT" = 0 ]; then
      PG_PORT="$actual_port"
      MINIME_PG_PORT="$actual_port"
      OWNER_DATABASE_URL="postgres://minime:minime@localhost:$actual_port/minime"
      DATABASE_URL="$OWNER_DATABASE_URL"
      export PG_PORT MINIME_PG_PORT OWNER_DATABASE_URL DATABASE_URL
    elif [ "$installed_new" = 1 ]; then
      brew_root="$(brew --prefix)"
      data_dir="$brew_root/var/postgresql@17"
      [ -f "$data_dir/postgresql.conf" ] ||
        die 20 postgres "new Homebrew PostgreSQL configuration is unavailable" \
          "inspect $data_dir, then re-run scripts/install.sh"
      printf '\nport = %s\n' "$PG_PORT" >> "$data_dir/postgresql.conf" ||
        die 20 postgres "could not configure Homebrew PostgreSQL on the selected port" \
          "set port = $PG_PORT in $data_dir/postgresql.conf, then re-run"
    else
      die 21 postgres "Homebrew PostgreSQL is configured on a different port" \
        "set MINIME_PG_PORT=$actual_port and the matching DATABASE_URL in .env, then re-run"
    fi
  elif [ -z "$actual_port" ] && [ "$PG_PORT_EXPLICIT" = 1 ] && [ "$installed_new" = 0 ]; then
    die 21 postgres "cannot verify the existing Homebrew PostgreSQL port" \
      "inspect postgresql@17 configuration and align MINIME_PG_PORT plus DATABASE_URL, then re-run"
  fi
  if ! "$pgbin/pg_isready" -h 127.0.0.1 -p "$PG_PORT" -q 2>/dev/null; then
    brew services start postgresql@17 >/dev/null 2>&1
    wait_pg_ready "$pgbin/pg_isready" ||
      die 20 postgres "Postgres did not become ready on localhost:$PG_PORT within 60s" \
        "brew services info postgresql@17; tail \$(brew --prefix)/var/log/postgresql@17.log"
  fi
  selected_pg_backend_matches_service ||
    die 20 postgres "Homebrew PostgreSQL identity does not match the selected port" \
      "inspect brew services and postgresql.conf, then re-run scripts/install.sh"
  if [ "$PG_LIFECYCLE_FRESH" = 0 ] && [ "$PG_INSTALL_PENDING" = 0 ]; then
    pg_owner_reachable ||
      die 21 postgres "persisted owner credentials failed before Homebrew bootstrap" \
        "repair DATABASE_URL credentials in .env, then re-run; no bootstrap SQL was applied"
  fi
  super_psql() { "$pgbin/psql" -h localhost -p "$PG_PORT" -d "$1" "${@:2}"; }
  ensure_pg_objects ||
    die 20 postgres "bootstrap SQL failed against Homebrew PostgreSQL" \
      "inspect postgresql@17 logs and credentials, then re-run scripts/install.sh"
}

provision_linux_native() {
  resolve_sudo || die 4 postgres "root needed to install postgresql-16/pgvector" \
    "re-run as root: sudo bash scripts/install.sh — or have an admin run: apt-get install postgresql-16 postgresql-16-pgvector, then re-run unprivileged"
  local created_cluster=0 found_port cluster_existed=0
  [ -n "$(linux_pg16_port)" ] && cluster_existed=1
  if ! dpkg -s postgresql-16-pgvector >/dev/null 2>&1; then
    note "adding PGDG apt repo + installing postgresql-16 (+pgvector)"
    ensure_pgdg_repo
    DEBIAN_FRONTEND=noninteractive $SUDO apt-get install -y -qq postgresql-16 postgresql-16-pgvector >/dev/null ||
      die 24 postgres "apt-get install postgresql-16 postgresql-16-pgvector failed" \
        "apt-get install postgresql-16 postgresql-16-pgvector (to see why), then re-run"
  fi
  # Some images (e.g. GitHub runners with a preexisting PG14) end up without a 16/main
  # cluster after package install — create it explicitly rather than assume postinst did.
  if [ -z "$(linux_pg16_port)" ]; then
    note "no 16/main cluster found — creating one"
    $SUDO pg_createcluster 16 main >/dev/null 2>&1
    created_cluster=1
  elif [ "$cluster_existed" = 0 ]; then
    # postinst created it during this installer run; it is safe to apply the caller's
    # explicit fresh-machine port before the cluster is started or persisted.
    created_cluster=1
  fi
  found_port="$(linux_pg16_port)"
  if [ "$found_port" != "$PG_PORT" ]; then
    if [ "$created_cluster" = 1 ] && [ "$PG_PORT_EXPLICIT" = 1 ]; then
      $SUDO pg_conftool 16 main set port "$PG_PORT" >/dev/null 2>&1 ||
        die 20 postgres "could not configure PostgreSQL 16/main on the selected port" \
          "sudo pg_conftool 16 main set port $PG_PORT, then re-run scripts/install.sh"
      # PGDG postinst may already have started this newly-created cluster on its default
      # port. Stop only that known-new 16/main instance so the start below reads the new port.
      $SUDO pg_ctlcluster 16 main stop >/dev/null 2>&1 || true
      found_port="$PG_PORT"
    elif [ "$PG_PORT_EXPLICIT" = 0 ]; then
      PG_PORT="$found_port"
      MINIME_PG_PORT="$found_port"
      OWNER_DATABASE_URL="postgres://minime:minime@localhost:$found_port/minime"
      DATABASE_URL="$OWNER_DATABASE_URL"
      export PG_PORT MINIME_PG_PORT OWNER_DATABASE_URL DATABASE_URL
    else
      die 21 postgres "PostgreSQL 16/main is configured on a different port" \
        "set MINIME_PG_PORT=$found_port and the matching DATABASE_URL in .env, then re-run"
    fi
  fi
  # Start exactly the 16/main cluster — never the generic 'postgresql' unit, which boots
  # every configured cluster (a stopped PG14 would grab 5432).
  if has_systemd; then
    $SUDO systemctl enable --now "postgresql@16-main" >/dev/null 2>&1 ||
      $SUDO pg_ctlcluster 16 main start 2>/dev/null || true
  else
    $SUDO pg_ctlcluster 16 main start 2>/dev/null || true # exit 2 = already running
  fi
  # Cluster config (not a live query) is the source of truth for the app's TCP port;
  # all bootstrap SQL is pinned to 16/main via postgresql-common's --cluster wrapper.
  found_port="$(linux_pg16_port)"
  [ "$found_port" = "$PG_PORT" ] ||
    die 20 postgres "PostgreSQL 16/main port changed unexpectedly" \
      "run pg_lsclusters and align MINIME_PG_PORT plus DATABASE_URL, then re-run"
  super_psql() { $SUDO -u postgres psql --cluster 16/main -d "$1" "${@:2}"; }
  if ! wait_pg_ready; then
    note "diagnostics: $(pg_lsclusters 2>/dev/null | tr '\n' ' | ')"
    note "$(tail -3 /var/log/postgresql/postgresql-16-main.log 2>/dev/null | tr '\n' ' | ')"
    die 20 postgres "Postgres 16/main did not become ready on localhost:$PG_PORT within 60s" \
      "pg_lsclusters; journalctl -u postgresql@16-main (or /var/log/postgresql/)"
  fi
  selected_pg_backend_matches_service ||
    die 20 postgres "PostgreSQL 16/main identity does not match the selected port" \
      "run pg_lsclusters and inspect Docker Compose state, then re-run scripts/install.sh"
  if [ "$PG_LIFECYCLE_FRESH" = 0 ] && [ "$PG_INSTALL_PENDING" = 0 ]; then
    pg_owner_reachable ||
      die 21 postgres "persisted owner credentials failed before PostgreSQL bootstrap" \
        "repair DATABASE_URL credentials in .env, then re-run; no bootstrap SQL was applied"
  fi
  ensure_pg_objects ||
    die 20 postgres "bootstrap SQL failed against cluster 16/main" \
      "sudo -u postgres psql --cluster 16/main -d postgres (then re-run scripts/install.sh)"
}

if [ "$PG_LIFECYCLE_FRESH" = 0 ] && [ "$PG_INSTALL_PENDING" = 0 ] && pg_bootstrap_complete; then
  selected_pg_backend_matches_service ||
    die 21 postgres "configured database is reachable through a different or unidentified backend" \
      "align MINIME_PG_BACKEND with the actual service in .env, then re-run"
  if [ "$PG_BACKEND" = docker ]; then pg_detail "docker pg16 @ 127.0.0.1:$PG_PORT" SKIP
  elif [ "$OS_FAMILY" = macos ]; then pg_detail "native pg17 (brew) @ 127.0.0.1:$PG_PORT" SKIP
  else pg_detail "native pg16 (PGDG) @ 127.0.0.1:$PG_PORT" SKIP
  fi
elif [ "$DRY_RUN" = 1 ]; then
  if [ "$PG_BACKEND" = docker ]; then pg_detail "(dry-run) would docker compose up pg16" OK
  else pg_detail "(dry-run) would install native postgres ($OS_FAMILY)" OK; fi
else
  # Never adopt an open port on an unpersisted fresh install. An interrupted rerun may
  # continue only when the persisted backend identity is the service holding the port.
  if ! pg_install_port_is_safe; then
    die 21 postgres "port $PG_PORT is occupied by another Postgres (not Minime's)" \
      "MINIME_PG_PORT=5433 bash scripts/install.sh (Docker path) — or stop the other Postgres and re-run"
  fi
  if [ "$PG_LIFECYCLE_FRESH" = 1 ] && ! validate_persisted_backend_service; then
    die 21 postgres "selected PostgreSQL backend conflicts with an existing service configuration" \
      "inspect the selected backend and choose a non-conflicting MINIME_PG_PORT, then re-run"
  fi
  # Record exact lifecycle intent before the first service mutation. If bootstrap fails,
  # MINIME_PG_INSTALL_PENDING lets a rerun resume only that selected backend rather than
  # rediscovering or adopting whatever happens to be listening.
  if [ "$PG_STATE_NEEDS_PERSIST" = 1 ]; then
    if [ ! -f .env ]; then
      cp .env.example .env || die 40 env "cannot write .env before PostgreSQL bootstrap" \
        "check repository permissions, then re-run"
      chmod 600 .env || die 40 env "cannot protect environment file" \
        "check repository permissions, then re-run"
      ENV_CREATED_EARLY=1
    fi
    persist_pg_lifecycle .env "$PG_STATE_REWRITE_OWNER" ||
      die 40 env "cannot persist PostgreSQL lifecycle intent" \
        "check repository permissions, then re-run; no PostgreSQL service was changed"
  fi
  if [ "$PG_BACKEND" = docker ]; then
    docker_available || die 22 postgres "persisted Docker backend is unavailable" \
      "start/install Docker, then re-run scripts/install.sh (the installer will not switch backends)"
    provision_docker || die 20 postgres "docker compose up did not become healthy" "docker compose logs db"
    pg_detail "docker pg16 @ 127.0.0.1:$PG_PORT" OK
  elif [ "$OS_FAMILY" = macos ]; then
    provision_macos_native
    pg_detail "native pg17 (brew) @ 127.0.0.1:$PG_PORT" OK
  else
    provision_linux_native
    pg_detail "native pg16 (PGDG) @ 127.0.0.1:$PG_PORT" OK
  fi
  selected_pg_backend_matches_service ||
    die 20 postgres "selected PostgreSQL backend identity does not match the configured port" \
      "inspect the selected service and MINIME_PG_BACKEND/MINIME_PG_PORT, then re-run"
  pg_bootstrap_complete || die 20 postgres "Postgres bootstrap invariant failed after provisioning" \
    "check DATABASE_URL credentials and the selected local service, then re-run scripts/install.sh"
fi

# Exact provision success closes the interrupted-install state. Keep the pending marker
# until this probe succeeds so every earlier failure remains safely resumable.
if [ "$DRY_RUN" = 0 ] && [ "$PG_INSTALL_PENDING" = 1 ]; then
  PG_INSTALL_PENDING=0
  persist_pg_lifecycle .env "$PG_STATE_REWRITE_OWNER" ||
    die 40 env "cannot finalize PostgreSQL lifecycle state" \
      "check repository permissions, then re-run; PostgreSQL is provisioned safely"
fi

# GitHub's Ubuntu 22 image prepends its bundled PostgreSQL 14 client directory to PATH.
# After installing the supported PG16 server, pin this installer process (including its
# verification suite and an idempotent re-run) to the matching client tools.
if [ "$OS_FAMILY" = debian ] && [ -x /usr/lib/postgresql/16/bin/pg_dump ]; then
  export PATH="/usr/lib/postgresql/16/bin:$PATH"
fi

# =============================== 4. .env =======================================
STEP=4
if [ "$ENV_CREATED_EARLY" = 1 ]; then
  line OK env "created from .env.example (lifecycle intent persisted before Postgres)"
elif [ -f .env ]; then
  line SKIP env ".env already exists (validated before Postgres; credentials preserved)"
elif [ "$DRY_RUN" = 1 ]; then
  line OK env "(dry-run) would create .env and persist PostgreSQL backend/port"
else
  cp .env.example .env || die 40 env "cannot write .env" "check repository permissions"
  line OK env "created from .env.example"
fi

if [ "$DRY_RUN" = 0 ]; then
  persist_pg_lifecycle .env "$PG_STATE_REWRITE_OWNER" ||
    die 40 env "cannot persist PostgreSQL lifecycle state" "check repository permissions, then re-run"
fi
owner_url="$OWNER_DATABASE_URL"
export DATABASE_URL="$owner_url"

# =============================== 5. ollama =====================================
STEP=5
degrade() { DEGRADED=1; SUMMARY_OLLAMA="$2"; line WARN ollama "$1"; note "continuing degraded: search=FTS-only, inbox=review-queue"; note "FIX later: $3"; }

pull_model() {
  local model="$1" pid started=$SECONDS last_beat=0 elapsed
  ollama_has_model "$model" && { note "model present: $model"; return 0; }
  ollama_pull_model "$model" "$PULL_TIMEOUT" &
  pid=$!
  while kill -0 "$pid" 2>/dev/null; do
    sleep 2
    elapsed=$((SECONDS - started))
    if [ $((elapsed - last_beat)) -ge 20 ]; then
      note "pulling $model (${elapsed}s elapsed)"
      last_beat=$elapsed
    fi
    if [ "$elapsed" -ge "$PULL_TIMEOUT" ]; then
      kill "$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
      note "pull of $model timed out after ${PULL_TIMEOUT}s (MINIME_PULL_TIMEOUT)"
      return 1
    fi
  done
  if wait "$pid"; then
    note "pulled $model"
    return 0
  fi
  note "pull failed for $model"
  return 1
}

if [ "$NO_OLLAMA" = 1 ]; then
  DEGRADED=1 SUMMARY_OLLAMA="skipped (--no-ollama; search=FTS-only, inbox=review-queue)"
  line SKIP ollama "--no-ollama given (degraded mode)"
elif [ "$DRY_RUN" = 1 ]; then
  line OK ollama "(dry-run) would ensure server + pull: $PULL_MODELS"
  SUMMARY_OLLAMA="(dry-run)"
else
  if ! ollama_reachable; then
    if ! have ollama; then
      if [ "$OS_FAMILY" = macos ]; then
        if have brew; then
          note "installing ollama via Homebrew"
          brew install -q ollama >/dev/null 2>&1 && brew services start ollama >/dev/null 2>&1
        fi
      else
        if resolve_sudo; then
          note "installing ollama via ollama.com/install.sh"
          curl -fsSL https://ollama.com/install.sh | $SUDO sh >/dev/null 2>&1
        fi
      fi
    fi
    # Only a plain HTTP root endpoint can launch a local server. HTTPS and paths
    # describe an existing proxy and must remain untouched when unreachable.
    if [ "$OLLAMA_CAN_LAUNCH" = 1 ] && have ollama && ! ollama_reachable; then
      nohup env -u OLLAMA_HOST OLLAMA_HOST="$OLLAMA_BIND_AUTHORITY" \
        ollama serve >.ollama-serve.log 2>&1 &
      for _ in $(seq 1 30); do ollama_reachable && break; sleep 1; done
    fi
  fi
  if ! ollama_reachable; then
    degrade "could not install/start ollama" "absent (search=FTS-only, inbox=review-queue)" \
      "install Ollama from ollama.com, then rerun: bash scripts/install.sh; then: make embed"
  else
    for model in $PULL_MODELS; do
      pull_model "$model" || true # absence is judged below, not per-pull
    done
    # The runtime needs BOTH models; degrade if either is absent for any reason
    # (pull failure, timeout, or a narrowed MINIME_PULL_MODELS).
    MISSING=""
    for model in "$EMBED_MODEL" "$CLASSIFY_MODEL"; do
      ollama_has_model "$model" || MISSING="$MISSING $model"
    done
    if [ -n "$MISSING" ]; then
      degrade "required model(s) absent:$MISSING" "partial (missing:$MISSING)" \
        "rerun: bash scripts/install.sh; then: make embed"
    else
      SUMMARY_OLLAMA="ok ($EMBED_MODEL,$CLASSIFY_MODEL)"
      line OK ollama "server up, models present: $EMBED_MODEL $CLASSIFY_MODEL"
    fi
  fi
fi

# =============================== 6. migrate ====================================
STEP=6
if [ "$DRY_RUN" = 1 ]; then
  line OK migrate "(dry-run) would apply db/migrations/*.sql"
else
  out="$(MINIME_APP_DATABASE_URL="$owner_url" bun run src/cli.ts migrate --context install 2>&1)" ||
    die 50 migrate "$(echo "$out" | tail -1)" "bun run src/cli.ts migrate --context install (full output)"
  line OK migrate "$(echo "$out" | tail -1)"
fi

# Cut over only after migration 021 has installed the least-privilege grants. A failed
# migration therefore cannot publish a credential for a half-configured resident role.
if [ "$DRY_RUN" = 0 ]; then
  if ! MINIME_APP_PASSWORD="$(repo_env_value MINIME_APP_PASSWORD .env 2>/dev/null)" ||
     ! [[ "$MINIME_APP_PASSWORD" =~ ^[A-Za-z0-9_-]{24,128}$ ]]; then
    if have openssl; then
      MINIME_APP_PASSWORD="$(openssl rand -hex 32)"
    else
      MINIME_APP_PASSWORD="$(head -c 48 /dev/urandom | base64 | tr -dc 'A-Za-z0-9_-' | cut -c1-64)"
    fi
    [ "${#MINIME_APP_PASSWORD}" -ge 24 ] || die 40 env "could not generate runtime role secret" \
      "install openssl, then re-run bash scripts/install.sh"
  fi
  APP_DATABASE_URL="$(DATABASE_URL="$owner_url" MINIME_APP_PASSWORD="$MINIME_APP_PASSWORD" \
    bun --no-env-file -e 'import { derivePostgresCredentials } from "./src/util/postgres-url"; console.log(derivePostgresCredentials(process.env.DATABASE_URL, "minime_app", process.env.MINIME_APP_PASSWORD, "minime"))')" ||
    die 40 env "could not derive restricted runtime endpoint" \
      "check DATABASE_URL in .env, then re-run bash scripts/install.sh"
  export MINIME_APP_PASSWORD
  export MINIME_APP_DATABASE_URL="$APP_DATABASE_URL"
  bun run scripts/provision-runtime-role.ts >/dev/null 2>&1 ||
    die 40 env "could not provision restricted runtime role" \
      "run bun scripts/provision-runtime-role.ts with the owner database configured, then re-run"
  chmod 600 .env || die 40 env "cannot protect environment file" "check repository permissions"
  env_tmp="$(mktemp .env.runtime.XXXXXX)" ||
    die 40 env "cannot stage runtime role endpoint" "check repository permissions"
  MINIME_APP_PASSWORD="$MINIME_APP_PASSWORD" MINIME_APP_DATABASE_URL="$APP_DATABASE_URL" awk \
    'BEGIN{seen_password=0;seen_url=0}
     /^MINIME_APP_PASSWORD=/{if(!seen_password){print "MINIME_APP_PASSWORD=" ENVIRON["MINIME_APP_PASSWORD"];seen_password=1};next}
     /^MINIME_APP_DATABASE_URL=/{if(!seen_url){print "MINIME_APP_DATABASE_URL=" ENVIRON["MINIME_APP_DATABASE_URL"];seen_url=1};next}
     {print}
     END{
       if(!seen_password) print "MINIME_APP_PASSWORD=" ENVIRON["MINIME_APP_PASSWORD"]
       if(!seen_url) print "MINIME_APP_DATABASE_URL=" ENVIRON["MINIME_APP_DATABASE_URL"]
     }' \
    .env >"$env_tmp" && chmod 600 "$env_tmp" && mv "$env_tmp" .env || {
    rm -f "$env_tmp"
    die 40 env "cannot publish runtime role endpoint" "check repository permissions"
  }
fi

# =============================== 7. demo seed ==================================
STEP=7
if [ "$WITH_DEMO" = 0 ]; then
  line SKIP demo "not requested (pass --with-demo for the fictional dataset)"
elif [ "$DRY_RUN" = 1 ]; then
  SUMMARY_DEMO="(dry-run)"
  line OK demo "(dry-run) would seed the fictional dataset"
else
  out="$(bun run src/cli.ts seed 2>&1)" || die 60 demo "$(echo "$out" | tail -1)" "bun run src/cli.ts seed (full output)"
  if echo "$out" | grep -q '"skipped"'; then
    SUMMARY_DEMO="already present (seed refused to double-load)"
    line SKIP demo "dataset already present"
  else
    SUMMARY_DEMO="seeded"
    line OK demo "fictional dataset loaded"
    [ "$DEGRADED" = 1 ] && note "embeddings deferred — run 'make embed' after pulling models"
  fi
fi

# =============================== 8. verify =====================================
STEP=8
if [ "$SKIP_VERIFY" = 1 ]; then
  line SKIP verify "--skip-verify given"
elif [ "$DRY_RUN" = 1 ]; then
  SUMMARY_VERIFY="(dry-run)"
  line OK verify "(dry-run) would run the canonical offline verification gate"
else
  if [ "$DEGRADED" = 0 ]; then
    bun run src/verify/m0.ts >/dev/null 2>&1 ||
      die 70 verify "verify-m0 failed" "bun run src/verify/m0.ts (full output)"
  fi
  if ! out="$(MINIME_INSTALLER_RUNNING=1 bash scripts/verify-offline.sh 2>&1)"; then
    printf '%s\n' "$out" | tail -30
    die 70 verify "offline verification gate failed" "bash scripts/verify-offline.sh (full output)"
  fi
  if [ "$DEGRADED" = 1 ]; then SUMMARY_VERIFY="pass-degraded (ollama mocked)"
  else SUMMARY_VERIFY="pass"; fi
  line OK verify "canonical offline gate green"
fi

# =============================== 9. MCP hints ==================================
STEP=9
REPO="$(pwd)"
line OK mcp "stdio server = bun run $REPO/src/cli.ts serve"
note "Claude Code (inside this repo): .mcp.json is auto-discovered — just restart in this directory"
note "Claude Code (global):  claude mcp add minime -- bun run $REPO/src/cli.ts serve"
note "other MCP harnesses:   {\"command\": \"bun\", \"args\": [\"run\", \"$REPO/src/cli.ts\", \"serve\"]}"

# =============================== summary =======================================
STATUS=ok
[ "$DEGRADED" = 1 ] && STATUS=degraded
echo "==== MINIME INSTALL SUMMARY ===="
echo "status: $STATUS"
echo "postgres: ${SUMMARY_PG:-unknown}"
echo "ollama: ${SUMMARY_OLLAMA:-ok}"
echo "demo: $SUMMARY_DEMO"
echo "verify: $SUMMARY_VERIFY"
echo "mcp: .mcp.json (in-repo) — see AGENTS.md to register elsewhere"
echo "first-run: bun run src/cli.ts onboard   (5-min interview: seed your values, goals, people)"
echo "next: bun run src/cli.ts serve"
echo "================================"
exit 0
