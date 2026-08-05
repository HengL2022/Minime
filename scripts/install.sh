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

line() { printf '[%d/%d] %-5s %s: %s\n' "$STEP" "$TOTAL" "$1" "$2" "$3"; }
note() { printf '      %s\n' "$*"; }
die() { # exit-code step-name error-sentence fix-command
  line FAIL "$2" "$3"
  echo "ERROR: $3"
  echo "FIX: $4"
  exit "$1"
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
if have bun; then
  line SKIP bun "$(bun --version) already installed"
elif [ "$DRY_RUN" = 1 ]; then
  line OK bun "(dry-run) would install via https://bun.sh/install"
else
  if [ "$OS_FAMILY" = debian ] && ! have unzip; then # bun installer hard-requires unzip
    resolve_sudo && DEBIAN_FRONTEND=noninteractive $SUDO apt-get install -y -qq unzip >/dev/null 2>&1
  fi
  curl -fsSL https://bun.sh/install | bash >/dev/null 2>&1
  export PATH="$HOME/.bun/bin:$PATH"
  have bun || die 10 bun "installer did not produce a working 'bun'" \
    "curl -fsSL https://bun.sh/install | bash && export PATH=\"\$HOME/.bun/bin:\$PATH\", then re-run scripts/install.sh"
  line OK bun "installed $(bun --version)"
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

# =============================== 3. postgres ===================================
STEP=3
pg_detail() { SUMMARY_PG="$1"; line "$2" postgres "$1"; }

provision_docker() {
  MINIME_PG_PORT="$PG_PORT" docker compose up -d --wait >/dev/null 2>&1 || return 1
  super_psql() { docker compose exec -T db psql -U minime -d "$1" "${@:2}"; }
  ensure_pg_objects
}

provision_macos_native() {
  have brew || die 22 postgres "neither Docker nor Homebrew found" \
    "install Docker Desktop (docker.com) or Homebrew (brew.sh), then re-run scripts/install.sh"
  local pgprefix pgbin
  pgprefix="$(brew --prefix postgresql@17 2>/dev/null)" || pgprefix=""
  if [ -z "$pgprefix" ] || [ ! -x "$pgprefix/bin/pg_isready" ]; then
    note "installing postgresql@17 + pgvector via Homebrew (a few minutes)"
    brew install -q postgresql@17 pgvector >/dev/null 2>&1 ||
      die 23 postgres "brew install postgresql@17 pgvector failed" "brew install postgresql@17 pgvector (to see why), then re-run"
    pgprefix="$(brew --prefix postgresql@17)"
  fi
  pgbin="$pgprefix/bin"
  if ! "$pgbin/pg_isready" -h 127.0.0.1 -p "$PG_PORT" -q 2>/dev/null; then
    brew services start postgresql@17 >/dev/null 2>&1
    wait_pg_ready "$pgbin/pg_isready" ||
      die 20 postgres "Postgres did not become ready on localhost:$PG_PORT within 60s" \
        "brew services info postgresql@17; tail \$(brew --prefix)/var/log/postgresql@17.log"
  fi
  super_psql() { "$pgbin/psql" -h localhost -p "$PG_PORT" -d "$1" "${@:2}"; }
  ensure_pg_objects
}

provision_linux_native() {
  resolve_sudo || die 4 postgres "root needed to install postgresql-16/pgvector" \
    "re-run as root: sudo bash scripts/install.sh — or have an admin run: apt-get install postgresql-16 postgresql-16-pgvector, then re-run unprivileged"
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
  local found_port
  found_port="$(linux_pg16_port)"
  [ -n "$found_port" ] && PG_PORT="$found_port"
  super_psql() { $SUDO -u postgres psql --cluster 16/main -d "$1" "${@:2}"; }
  if ! wait_pg_ready; then
    note "diagnostics: $(pg_lsclusters 2>/dev/null | tr '\n' ' | ')"
    note "$(tail -3 /var/log/postgresql/postgresql-16-main.log 2>/dev/null | tr '\n' ' | ')"
    die 20 postgres "Postgres 16/main did not become ready on localhost:$PG_PORT within 60s" \
      "pg_lsclusters; journalctl -u postgresql@16-main (or /var/log/postgresql/)"
  fi
  ensure_pg_objects ||
    die 20 postgres "bootstrap SQL failed against cluster 16/main" \
      "sudo -u postgres psql --cluster 16/main -d postgres (then re-run scripts/install.sh)"
}

if pg_provisioned; then
  pg_detail "already provisioned @ 127.0.0.1:$PG_PORT" SKIP
elif [ "$DRY_RUN" = 1 ]; then
  if docker_available && [ "$FORCE_NATIVE" = 0 ]; then pg_detail "(dry-run) would docker compose up pg16" OK
  else pg_detail "(dry-run) would install native postgres ($OS_FAMILY)" OK; fi
else
  # something else already owns the port -> docker bind / brew start would fail confusingly
  if port_open "$PG_PORT"; then
    die 21 postgres "port $PG_PORT is occupied by another Postgres (not Minime's)" \
      "MINIME_PG_PORT=5433 bash scripts/install.sh (Docker path) — or stop the other Postgres and re-run"
  fi
  if docker_available && [ "$FORCE_NATIVE" = 0 ]; then
    provision_docker || die 20 postgres "docker compose up did not become healthy" "docker compose logs db"
    pg_detail "docker pg16 @ 127.0.0.1:$PG_PORT" OK
  elif [ "$OS_FAMILY" = macos ]; then
    provision_macos_native
    pg_detail "native pg17 (brew) @ 127.0.0.1:$PG_PORT" OK
  else
    provision_linux_native
    pg_detail "native pg16 (PGDG) @ 127.0.0.1:$PG_PORT" OK
  fi
  pg_provisioned || die 20 postgres "Postgres provisioned but the minime database probe still fails" \
    "PROBE_URL=postgres://minime:minime@localhost:$PG_PORT/minime bun scripts/pg-probe.ts (to see why)"
fi

# GitHub's Ubuntu 22 image prepends its bundled PostgreSQL 14 client directory to PATH.
# After installing the supported PG16 server, pin this installer process (including its
# verification suite and an idempotent re-run) to the matching client tools.
if [ "$OS_FAMILY" = debian ] && [ -x /usr/lib/postgresql/16/bin/pg_dump ]; then
  export PATH="/usr/lib/postgresql/16/bin:$PATH"
fi

# =============================== 4. .env =======================================
STEP=4
installer_endpoint_matches() {
  # Parse only the endpoint identity. Secrets stay in the environment and the helper emits
  # no URL, so a malformed or remote .env can never echo credentials into installer output.
  local owner_url="$1" target_url="$2"
  MINIME_INSTALL_OWNER_URL="$owner_url" MINIME_INSTALL_TARGET_URL="$target_url" \
    MINIME_SKIP_REPO_DOTENV=1 bun -e '
      const loopback = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
      const endpoint = (raw) => {
        let url;
        try { url = new URL(raw); } catch { return undefined; }
        if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") return undefined;
        const host = url.hostname.toLowerCase();
        if (!loopback.has(host)) return undefined;
        let database;
        try { database = decodeURIComponent(url.pathname.replace(/^\//, "")); } catch { return undefined; }
        if (database !== "minime") return undefined;
        return `loopback:${url.port || "5432"}/${database}`;
      };
      const owner = new URL(process.env.MINIME_INSTALL_OWNER_URL || "");
      const target = new URL(process.env.MINIME_INSTALL_TARGET_URL || "");
      const ownerEndpoint = endpoint(owner.toString());
      const targetEndpoint = endpoint(target.toString());
      const ok = Boolean(ownerEndpoint && targetEndpoint && ownerEndpoint === targetEndpoint) &&
        Boolean(owner.username) && owner.username !== "minime_app" && target.username === "minime" &&
        target.hostname.toLowerCase() === "localhost";
      process.exit(ok ? 0 : 1);
    ' >/dev/null 2>&1
}

if [ -f .env ]; then
  line SKIP env ".env already exists (endpoint will be validated; credentials never rewritten)"
elif [ "$DRY_RUN" = 1 ]; then
  line OK env "(dry-run) would copy .env.example -> .env"
else
  cp .env.example .env || die 40 env "cannot write .env" "check repository permissions"
  if [ "$PG_PORT" != 5432 ]; then
    sed -i.bak "s#localhost:5432#localhost:$PG_PORT#" .env && rm -f .env.bak
  fi
  line OK env "created from .env.example"
fi

# The owner DSN is the control-plane connection used by migrations/provisioning. Existing
# installs may use a different owner password, but the endpoint must remain the installer's
# local minime database. Reject before Ollama/migration work instead of silently retargeting.
if [ "$DRY_RUN" = 0 ] || [ -f .env ]; then
  owner_url="$(repo_env_value DATABASE_URL .env 2>/dev/null || true)"
  [ -n "$owner_url" ] || die 40 env "DATABASE_URL is required in existing .env" \
    "set DATABASE_URL=postgres://<owner>:<password>@localhost:$PG_PORT/minime in .env, then re-run"
  installer_target="postgres://minime:minime@localhost:$PG_PORT/minime"
  installer_endpoint_matches "$owner_url" "$installer_target" ||
    die 40 env "DATABASE_URL must target the installer loopback endpoint" \
      "set DATABASE_URL=postgres://<owner>:<password>@localhost:$PG_PORT/minime in .env, then re-run"
  export DATABASE_URL="$owner_url"
fi

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
  out="$(bun run src/cli.ts migrate --context install 2>&1)" ||
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
  APP_DATABASE_URL="postgres://minime_app:$MINIME_APP_PASSWORD@localhost:$PG_PORT/minime"
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
  line OK verify "(dry-run) would run verify-m0 + offline test suite"
else
  if [ "$DEGRADED" = 1 ]; then
    MINIME_MOCK_OLLAMA=1 bun run src/verify/m0.ts >/dev/null 2>&1 ||
      die 70 verify "environment check failed even with ollama mocked" "MINIME_MOCK_OLLAMA=1 bun run src/verify/m0.ts (full output)"
    SUMMARY_VERIFY="pass-degraded (ollama mocked)"
  else
    bun run src/verify/m0.ts >/dev/null 2>&1 ||
      die 70 verify "verify-m0 failed" "bun run src/verify/m0.ts (full output)"
    SUMMARY_VERIFY="pass"
  fi
  if ! out="$(MINIME_INSTALLER_RUNNING=1 bun test 2>&1)"; then
    printf '%s\n' "$out" | tail -30 # surface the failing tests; agents read the tail
    die 70 verify "offline test suite failed" "bun test (full output)"
  fi
  line OK verify "verify-m0 + offline test suite green"
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
