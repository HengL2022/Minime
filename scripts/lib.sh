# shellcheck shell=bash
# Shared helpers for scripts/up.sh and scripts/install.sh. Source, don't execute.

PG_PORT="${MINIME_PG_PORT:-5432}"
PG_BACKEND=""
OWNER_DATABASE_URL=""
PG_STATE_RULE=""
PG_STATE_NEEDS_PERSIST=0
PG_STATE_REWRITE_OWNER=0
PG_PORT_EXPLICIT=0
PG_LIFECYCLE_FRESH=0
PG_INSTALL_PENDING=0
EMBED_MODEL="${EMBED_MODEL:-nomic-embed-text}"
CLASSIFY_MODEL="${CLASSIFY_MODEL:-llama3.1:8b}"

trim_shell_value() {
  local value="$1"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "$value"
}

repo_env_value() {
  local wanted="$1" file="$2" raw line key value result="" found=0
  [ -f "$file" ] || return 1
  while IFS= read -r raw || [ -n "$raw" ]; do
    line="$(trim_shell_value "$raw")"
    [ -z "$line" ] && continue
    case "$line" in \#*) continue ;; esac
    case "$line" in export\ *) line="$(trim_shell_value "${line#export }")" ;; esac
    case "$line" in *=*) ;; *) continue ;; esac
    key="$(trim_shell_value "${line%%=*}")"
    [ "$key" = "$wanted" ] || continue
    value="$(trim_shell_value "${line#*=}")"
    if [[ "$value" =~ ^\"(.*)\"$ ]] || [[ "$value" =~ ^\'(.*)\'$ ]]; then
      value="${BASH_REMATCH[1]}"
    elif [[ "$value" = *[[:space:]]\#* ]]; then
      value="${value%%[[:space:]]\#*}"
      value="$(trim_shell_value "$value")"
    fi
    result="$value"
    found=1
  done < "$file"
  [ "$found" = 1 ] || return 1
  printf '%s' "$result"
}

resolve_ollama_url() {
  if [ "${OLLAMA_URL+x}" = x ]; then return 0; fi
  if OLLAMA_URL="$(repo_env_value OLLAMA_URL .env)"; then export OLLAMA_URL; return 0; fi
  OLLAMA_URL="http://localhost:11434"
  export OLLAMA_URL
}

ollama_url_fail() {
  OLLAMA_URL_RULE="$1"
  return 1
}

ollama_preflight_error() {
  printf 'OLLAMA_URL rejected (%s)' "$OLLAMA_URL_RULE"
}

ollama_preflight_fix() {
  printf '%s' 'set OLLAMA_URL=http://localhost:11434, then retry'
}

ollama_preparse_raw_path() {
  local raw_path="$1" segment="" index=0 char hex
  case "$raw_path" in *\\*) ollama_url_fail path_segment; return 1 ;; esac
  while [ "$index" -lt "${#raw_path}" ]; do
    char="${raw_path:index:1}"
    if [ "$char" = "%" ]; then
      hex="${raw_path:index+1:2}"
      if [[ "$hex" =~ ^[0-9A-Fa-f]{2}$ ]]; then
        case "$hex" in
          2[fF]|5[cC]) ollama_url_fail path_segment; return 1 ;;
          2[eE]) ollama_url_fail path_segment; return 1 ;;
        esac
      fi
    fi
    if [ "$char" = "/" ]; then
      [ "$segment" != "." ] && [ "$segment" != ".." ] ||
        { ollama_url_fail path_segment; return 1; }
      segment=""
    else
      segment="${segment}${char}"
    fi
    index=$((index + 1))
  done
  [ "$segment" != "." ] && [ "$segment" != ".." ] ||
    { ollama_url_fail path_segment; return 1; }
}

ollama_reject_non_printable_ascii() {
  local LC_ALL=C raw="$1" index=0 char byte
  while [ "$index" -lt "${#raw}" ]; do
    char="${raw:index:1}"
    printf -v byte '%d' "'$char"
    [ "$byte" -ge 33 ] && [ "$byte" -le 126 ] ||
      { ollama_url_fail endpoint_byte; return 1; }
    index=$((index + 1))
  done
}

validate_ollama_url() {
  local raw="$1" authority raw_host raw_port="" path="" hostname part
  local ipv6=0 had_trailing_dot=0 p1 p2 p3 p4 p5 port_value port_digits
  OLLAMA_URL_RULE=""
  [ -n "$raw" ] || { ollama_url_fail empty; return 1; }
  [[ "$raw" != *[[:cntrl:]]* ]] ||
    { ollama_url_fail control_character; return 1; }
  [ "$raw" = "$(trim_shell_value "$raw")" ] ||
    { ollama_url_fail surrounding_whitespace; return 1; }
  ollama_reject_non_printable_ascii "$raw" || return 1
  case "$raw" in *\?*|*\#*) ollama_url_fail query_or_fragment; return 1 ;; esac
  if [[ ! "$raw" =~ ^([A-Za-z][A-Za-z0-9+.-]*)://([^/?#]*)(/[^?#]*)?$ ]]; then
    ollama_url_fail syntax; return 1
  fi
  case "${BASH_REMATCH[1]}" in
    [Hh][Tt][Tt][Pp]) OLLAMA_SCHEME=http ;;
    [Hh][Tt][Tt][Pp][Ss]) OLLAMA_SCHEME=https ;;
    *) ollama_url_fail scheme; return 1 ;;
  esac
  authority="${BASH_REMATCH[2]}"
  path="${BASH_REMATCH[3]}"
  [ -n "$authority" ] || { ollama_url_fail syntax; return 1; }
  case "$authority" in *@*) ollama_url_fail credentials; return 1 ;; esac
  case "$authority" in *%*) ollama_url_fail authority_encoding; return 1 ;; esac
  ollama_preparse_raw_path "$path" || return 1

  if [[ "$authority" = \[* ]]; then
    if [[ "$authority" =~ ^\[([^]]+)\]$ ]]; then
      raw_host="${BASH_REMATCH[1]}"
      ipv6=1
    elif [[ "$authority" =~ ^\[([^]]+)\]:(.*)$ ]]; then
      raw_host="${BASH_REMATCH[1]}"
      raw_port="${BASH_REMATCH[2]}"
      ipv6=1
      [ -n "$raw_port" ] || { ollama_url_fail port; return 1; }
    else
      ollama_url_fail syntax; return 1
    fi
  else
    local colons="${authority//[^:]/}"
    [ "${#colons}" -le 1 ] || { ollama_url_fail syntax; return 1; }
    if [[ "$authority" = *:* ]]; then
      raw_host="${authority%:*}"
      raw_port="${authority##*:}"
      [ -n "$raw_port" ] || { ollama_url_fail port; return 1; }
    else
      raw_host="$authority"
    fi
  fi
  [ -n "$raw_host" ] || { ollama_url_fail syntax; return 1; }

  hostname="$raw_host"
  if [ "$ipv6" = 1 ] && [[ "$hostname" = *. ]]; then
    ollama_url_fail syntax; return 1
  fi
  if [[ "$hostname" = *. ]]; then
    had_trailing_dot=1
    hostname="${hostname%.}"
  fi
  [ -n "$hostname" ] && [[ "$hostname" != *. ]] ||
    { ollama_url_fail syntax; return 1; }
  if [ "$had_trailing_dot" = 1 ] && [ "$ipv6" = 0 ] &&
     ! [[ "$hostname" =~ ^[Ll][Oo][Cc][Aa][Ll][Hh][Oo][Ss][Tt]$ ]]; then
    ollama_url_fail syntax; return 1
  fi

  if [ "$ipv6" = 1 ]; then
    [[ "$hostname" =~ ^[0-9]+(\.[0-9]+){3}$ ]] &&
      { ollama_url_fail syntax; return 1; }
    [ "$hostname" = "::1" ] || { ollama_url_fail non_loopback_host; return 1; }
    OLLAMA_NORMALIZED_HOST="::1"
    OLLAMA_CONNECT_HOST="::1"
  elif [[ "$hostname" =~ ^[Ll][Oo][Cc][Aa][Ll][Hh][Oo][Ss][Tt]$ ]]; then
    OLLAMA_NORMALIZED_HOST="localhost"
    OLLAMA_CONNECT_HOST="127.0.0.1"
  else
    if [[ "$hostname" =~ ^[0-9]+$ ]] ||
       [[ "$hostname" =~ ^0[xX][0-9A-Fa-f]+$ ]]; then
      ollama_url_fail ambiguous_numeric_host; return 1
    fi
    [[ "$hostname" =~ ^[0-9.]+$ ]] ||
      { ollama_url_fail non_loopback_host; return 1; }
    IFS=. read -r p1 p2 p3 p4 p5 <<< "$hostname"
    [ -n "$p1" ] && [ -n "$p2" ] && [ -n "$p3" ] && [ -n "$p4" ] && [ -z "$p5" ] ||
      { ollama_url_fail ambiguous_numeric_host; return 1; }
    for part in "$p1" "$p2" "$p3" "$p4"; do
      [[ "$part" =~ ^(0|[1-9][0-9]{0,2})$ ]] ||
        { ollama_url_fail ambiguous_numeric_host; return 1; }
      [ "$((10#$part))" -le 255 ] ||
        { ollama_url_fail ambiguous_numeric_host; return 1; }
    done
    [ "$p1" = 127 ] || { ollama_url_fail non_loopback_host; return 1; }
    OLLAMA_NORMALIZED_HOST="$p1.$p2.$p3.$p4"
    OLLAMA_CONNECT_HOST="$OLLAMA_NORMALIZED_HOST"
  fi

  if [ -n "$raw_port" ]; then
    [[ "$raw_port" =~ ^[0-9]+$ ]] || { ollama_url_fail port; return 1; }
    port_digits="$raw_port"
    while [ "${#port_digits}" -gt 1 ] && [[ "$port_digits" = 0* ]]; do
      port_digits="${port_digits#0}"
    done
    [ "${#port_digits}" -le 5 ] || { ollama_url_fail port; return 1; }
    port_value=$((10#$port_digits))
    [ "$port_value" -ge 1 ] && [ "$port_value" -le 65535 ] ||
      { ollama_url_fail port; return 1; }
    OLLAMA_PORT="$port_value"
  elif [ "$OLLAMA_SCHEME" = http ]; then
    OLLAMA_PORT=80
  else
    OLLAMA_PORT=443
  fi

  while [ -n "$path" ] && [[ "$path" = */ ]]; do path="${path%/}"; done
  OLLAMA_BASE_PATH="$path"
  OLLAMA_HOST_HEADER="$authority"
  OLLAMA_CAN_LAUNCH=0
  if [ "$OLLAMA_SCHEME" = http ] && [ -z "$OLLAMA_BASE_PATH" ]; then
    OLLAMA_CAN_LAUNCH=1
  fi
  if [ "$OLLAMA_NORMALIZED_HOST" = "::1" ]; then
    OLLAMA_BIND_AUTHORITY="[::1]:$OLLAMA_PORT"
  else
    OLLAMA_BIND_AUTHORITY="$OLLAMA_CONNECT_HOST:$OLLAMA_PORT"
  fi
  return 0
}

ollama_preflight() {
  resolve_ollama_url
  validate_ollama_url "$OLLAMA_URL"
}

have() { command -v "$1" >/dev/null 2>&1; }
is_macos() { [ "$(uname -s)" = "Darwin" ]; }
is_debianish() { [ -f /etc/debian_version ]; }
has_systemd() { [ -d /run/systemd/system ]; }

docker_available() { have docker && docker info >/dev/null 2>&1; }

pinned_bun_version() {
  local pin_file=".bun-version" version
  [ -f "$pin_file" ] || return 1
  version="$(tr -d '\r\n' < "$pin_file")"
  [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || return 1
  printf '%s' "$version"
}

pinned_bun_matches() {
  local required
  required="$(pinned_bun_version)" || return 1
  have bun && [ "$(bun --version 2>/dev/null)" = "$required" ]
}

install_pinned_bun() {
  local required
  required="$(pinned_bun_version)" || return 1
  curl -fsSL https://bun.sh/install | bash -s -- "bun-v$required" >/dev/null 2>&1 || return 1
  export PATH="$HOME/.bun/bin:$PATH"
  pinned_bun_matches
}

valid_pg_port() {
  local digits="$1" value
  [[ "$digits" =~ ^[0-9]+$ ]] || return 1
  while [ "${#digits}" -gt 1 ] && [[ "$digits" = 0* ]]; do digits="${digits#0}"; done
  [ "${#digits}" -le 5 ] || return 1
  value=$((10#$digits))
  [ "$value" -ge 1 ] && [ "$value" -le 65535 ]
}

normalized_pg_port() {
  local digits="$1"
  valid_pg_port "$digits" || return 1
  while [ "${#digits}" -gt 1 ] && [[ "$digits" = 0* ]]; do digits="${digits#0}"; done
  printf '%s' "$digits"
}

validated_owner_port() {
  local owner_url="$1" port
  have bun || return 1
  port="$(MINIME_LIFECYCLE_OWNER_URL="$owner_url" bun --no-env-file -e '
    import { parseLocalPostgresUrl } from "./src/util/postgres-url";
    try {
      const owner = parseLocalPostgresUrl(process.env.MINIME_LIFECYCLE_OWNER_URL || "", "minime");
      const username = decodeURIComponent(owner.url.username);
      if (!username || username === "minime_app") process.exit(1);
      console.log(owner.port);
    } catch { process.exit(1); }
  ' 2>/dev/null)" || return 1
  normalized_pg_port "$port"
}

# Fresh bootstrap SQL and the Compose image both create the fixed owner
# minime:minime.  Existing installations may use rotated/custom owner credentials,
# but a setup-only .env must not advertise credentials the bootstrap cannot create.
fresh_owner_bootstrap_compatible() {
  local owner_url="$1"
  MINIME_LIFECYCLE_OWNER_URL="$owner_url" bun --no-env-file -e '
    import { parseLocalPostgresUrl } from "./src/util/postgres-url";
    try {
      const owner = parseLocalPostgresUrl(process.env.MINIME_LIFECYCLE_OWNER_URL || "", "minime");
      const username = decodeURIComponent(owner.url.username);
      const password = decodeURIComponent(owner.url.password);
      process.exit(username === "minime" && password === "minime" ? 0 : 1);
    } catch { process.exit(1); }
  ' >/dev/null 2>&1
}

retarget_validated_owner_port() {
  local owner_url="$1" requested_port="$2"
  requested_port="$(normalized_pg_port "$requested_port")" || return 1
  MINIME_LIFECYCLE_OWNER_URL="$owner_url" \
  MINIME_LIFECYCLE_OWNER_PORT="$requested_port" \
    bun --no-env-file -e '
      import { parseLocalPostgresUrl } from "./src/util/postgres-url";
      try {
        const owner = parseLocalPostgresUrl(process.env.MINIME_LIFECYCLE_OWNER_URL || "", "minime");
        const username = decodeURIComponent(owner.url.username);
        if (!username || username === "minime_app") process.exit(1);
        owner.url.port = process.env.MINIME_LIFECYCLE_OWNER_PORT || "";
        process.stdout.write(owner.url.toString());
      } catch { process.exit(1); }
    ' 2>/dev/null
}

validated_app_owner_pair() {
  local owner_url="$1" app_url="$2"
  MINIME_LIFECYCLE_OWNER_URL="$owner_url" \
  MINIME_LIFECYCLE_APP_URL="$app_url" \
    bun --no-env-file -e '
      import { validateMinimeDatabasePair } from "./src/util/postgres-url";
      try {
        const pair = validateMinimeDatabasePair(
          process.env.MINIME_LIFECYCLE_OWNER_URL || "",
          process.env.MINIME_LIFECYCLE_APP_URL || "",
        );
        const ownerUser = decodeURIComponent(pair.owner.url.username);
        const appUser = decodeURIComponent(pair.app.url.username);
        if (!ownerUser || ownerUser === "minime_app" || appUser !== "minime_app") process.exit(1);
      } catch { process.exit(1); }
    ' >/dev/null 2>&1
}

docker_container_port() {
  local container="$1" port
  [ -n "$container" ] || return 1
  port="$(docker inspect --format '{{(index (index .HostConfig.PortBindings "5432/tcp") 0).HostPort}}' \
    "$container" 2>/dev/null)" || return 1
  normalized_pg_port "$port"
}

# A persisted Docker selection may refer to a stopped Compose container. Keep that
# configured identity separate from the running identity used to adopt legacy state
# and to certify a database that already answered the generic credential probe.
docker_backend_port() {
  local container
  docker_available || return 1
  container="$(docker compose ps -q --all db 2>/dev/null | head -1)"
  docker_container_port "$container"
}

docker_backend_matches_port() {
  local actual
  actual="$(docker_backend_port)" || return 1
  [ "$actual" = "$1" ]
}

docker_running_backend_port() {
  local container
  docker_available || return 1
  container="$(docker compose ps -q db 2>/dev/null | head -1)"
  docker_container_port "$container"
}

docker_running_backend_matches_port() {
  local actual
  actual="$(docker_running_backend_port)" || return 1
  [ "$actual" = "$1" ]
}

macos_native_pg_port() {
  local brew_root data_dir configured
  have brew || return 1
  brew --prefix postgresql@17 >/dev/null 2>&1 || return 1
  brew_root="$(brew --prefix 2>/dev/null)" || return 1
  data_dir="$brew_root/var/postgresql@17"
  [ -f "$data_dir/PG_VERSION" ] || return 1
  configured="$(awk '
    /^[[:space:]]*port[[:space:]]*=/ {
      value=$0
      sub(/^[^=]*=/, "", value)
      sub(/^[[:space:]]*/, "", value)
      sub(/[[:space:]]*#.*/, "", value)
      sub(/[[:space:]]*$/, "", value)
      last=value
    }
    END { if (last != "") print last }
  ' "$data_dir/postgresql.conf" 2>/dev/null)"
  normalized_pg_port "${configured:-5432}"
}

native_backend_port() {
  if is_macos; then macos_native_pg_port
  elif is_debianish; then linux_pg16_port
  else return 1
  fi
}

native_backend_matches_port() {
  local actual
  actual="$(native_backend_port)" || return 1
  [ "$actual" = "$1" ]
}

macos_native_pg_running_port() {
  local pgprefix brew_root data_dir
  have brew || return 1
  pgprefix="$(brew --prefix postgresql@17 2>/dev/null)" || return 1
  brew_root="$(brew --prefix 2>/dev/null)" || return 1
  data_dir="$brew_root/var/postgresql@17"
  [ -x "$pgprefix/bin/pg_ctl" ] && [ -f "$data_dir/PG_VERSION" ] || return 1
  "$pgprefix/bin/pg_ctl" -D "$data_dir" status >/dev/null 2>&1 || return 1
  macos_native_pg_port
}

linux_pg16_running_port() {
  pg_lsclusters -h 2>/dev/null | awk '$1==16 && $2=="main" && $4=="online" {print $3; exit}'
}

native_running_backend_port() {
  if is_macos; then macos_native_pg_running_port
  elif is_debianish; then linux_pg16_running_port
  else return 1
  fi
}

native_running_backend_matches_port() {
  local actual
  actual="$(native_running_backend_port)" || return 1
  [ "$actual" = "$1" ]
}

pg_state_fail() {
  PG_STATE_RULE="$1"
  return 1
}

select_fresh_pg_backend() {
  local force_native="$1" requested="${MINIME_PG_BACKEND:-}"
  if [ -n "$requested" ] && [ "$requested" != native ] && [ "$requested" != docker ]; then
    pg_state_fail backend
    return 1
  fi
  if [ "$force_native" = 1 ]; then PG_BACKEND=native
  elif [ -n "$requested" ]; then PG_BACKEND="$requested"
  elif docker_available; then PG_BACKEND=docker
  else PG_BACKEND=native
  fi
}

validate_persisted_backend_service() {
  local running_docker_match=0 configured_docker_port configured_native_port
  docker_running_backend_matches_port "$PG_PORT" && running_docker_match=1
  if [ "$PG_BACKEND" = native ] && [ "$running_docker_match" = 1 ]; then
    pg_state_fail backend_service_mismatch
    return 1
  fi
  if [ "$PG_BACKEND" = docker ]; then
    configured_docker_port="$(docker_backend_port 2>/dev/null || true)"
    if [ -n "$configured_docker_port" ] && [ "$configured_docker_port" != "$PG_PORT" ]; then
      pg_state_fail backend_service_mismatch
      return 1
    fi
  elif [ "$PG_BACKEND" = native ]; then
    configured_native_port="$(native_backend_port 2>/dev/null || true)"
    if [ -n "$configured_native_port" ] && [ "$configured_native_port" != "$PG_PORT" ]; then
      pg_state_fail backend_service_mismatch
      return 1
    fi
  fi
}

selected_pg_backend_matches_service() {
  if [ "$PG_BACKEND" = docker ]; then
    docker_running_backend_matches_port "$PG_PORT"
  elif [ "$PG_BACKEND" = native ]; then
    native_running_backend_matches_port "$PG_PORT" &&
      ! docker_running_backend_matches_port "$PG_PORT"
  else return 1
  fi
}

# An unpersisted fresh install never treats an already-open port as its own, even
# when the service shape happens to match.  Once install intent has been persisted,
# a rerun may continue only through the exact selected backend identity.
pg_install_port_is_safe() {
  if [ "$PG_LIFECYCLE_FRESH" = 1 ]; then
    # TCP/IPv4 is not the only way a native cluster can be online. Never bootstrap a
    # fresh setup into any already-running known backend, even when it listens only on
    # ::1 or a Unix socket and the IPv4 port probe appears closed.
    docker_running_backend_matches_port "$PG_PORT" && return 1
    native_running_backend_matches_port "$PG_PORT" && return 1
    ! port_open "$PG_PORT"
    return $?
  fi
  if ! port_open "$PG_PORT"; then return 0; fi
  selected_pg_backend_matches_service
}

# A stop action must never target a service whose configured identity conflicts with
# persisted state. A missing Docker container is an idempotent no-op; a native service
# must have an inspectable matching cluster because its stop command is system-wide.
selected_pg_backend_safe_to_stop() {
  local configured_port
  if [ "$PG_BACKEND" = docker ]; then
    configured_port="$(docker_backend_port 2>/dev/null || true)"
    [ -z "$configured_port" ] || [ "$configured_port" = "$PG_PORT" ]
  elif [ "$PG_BACKEND" = native ]; then
    native_backend_matches_port "$PG_PORT"
  else
    return 1
  fi
}

adopt_legacy_pg_backend() {
  local force_native="$1" allow_fresh="${2:-0}" app_url="${3:-}"
  local docker_match=0 native_match=0
  if [ -z "$app_url" ]; then
    if [ "$allow_fresh" != 1 ]; then
      pg_state_fail install_required
      return 1
    fi
    select_fresh_pg_backend "$force_native" || return 1
    PG_LIFECYCLE_FRESH=1
    PG_INSTALL_PENDING=1
    PG_STATE_NEEDS_PERSIST=1
    return 0
  fi
  docker_running_backend_matches_port "$PG_PORT" && docker_match=1
  native_running_backend_matches_port "$PG_PORT" && native_match=1
  # A running Minime Compose service owns this port even when a stopped/configured
  # native cluster happens to advertise the same port.
  if [ "$docker_match" = 1 ]; then PG_BACKEND=docker
  elif [ "$native_match" = 1 ]; then PG_BACKEND=native
  else
    pg_state_fail legacy_backend_unknown
    return 1
  fi
  PG_STATE_NEEDS_PERSIST=1
}

# Resolve the one persisted PostgreSQL lifecycle identity before any database probe/action.
# Existing .env credentials and state win; fresh caller choices are considered only when no
# complete state exists. The URL is passed to Bun through the environment and never printed.
resolve_pg_lifecycle() {
  local env_file="${1:-.env}" force_native="${2:-0}" allow_fresh="${3:-0}"
  local owner_url persisted_backend persisted_port persisted_pending
  local caller_port="${MINIME_PG_PORT:-}" url_port app_url
  PG_STATE_RULE=""
  PG_STATE_NEEDS_PERSIST=0
  PG_STATE_REWRITE_OWNER=0
  PG_PORT_EXPLICIT=0
  PG_LIFECYCLE_FRESH=0
  PG_INSTALL_PENDING=0

  if [ -f "$env_file" ]; then
    owner_url="$(repo_env_value DATABASE_URL "$env_file" 2>/dev/null || true)"
    [ -n "$owner_url" ] || { pg_state_fail database_url_missing; return 1; }
    url_port="$(validated_owner_port "$owner_url")" || {
      pg_state_fail database_url
      return 1
    }
    persisted_backend="$(repo_env_value MINIME_PG_BACKEND "$env_file" 2>/dev/null || true)"
    persisted_port="$(repo_env_value MINIME_PG_PORT "$env_file" 2>/dev/null || true)"
    persisted_pending="$(repo_env_value MINIME_PG_INSTALL_PENDING "$env_file" 2>/dev/null || true)"
    app_url="$(repo_env_value MINIME_APP_DATABASE_URL "$env_file" 2>/dev/null || true)"
    if [ -n "$persisted_backend" ] || [ -n "$persisted_port" ] || [ -n "$persisted_pending" ]; then
      [ "$persisted_backend" = native ] || [ "$persisted_backend" = docker ] || {
        pg_state_fail backend
        return 1
      }
      persisted_port="$(normalized_pg_port "$persisted_port")" || {
        pg_state_fail port
        return 1
      }
      [ "$persisted_port" = "$url_port" ] || {
        pg_state_fail port_url_mismatch
        return 1
      }
      PG_BACKEND="$persisted_backend"
      PG_PORT="$persisted_port"
      PG_PORT_EXPLICIT=1
      case "$persisted_pending" in
        ""|0) PG_INSTALL_PENDING=0 ;;
        1) PG_INSTALL_PENDING=1 ;;
        *) pg_state_fail install_pending; return 1 ;;
      esac
      if [ "$PG_INSTALL_PENDING" = 1 ] &&
         ! fresh_owner_bootstrap_compatible "$owner_url"; then
        pg_state_fail fresh_owner_credentials
        return 1
      fi
      if [ -n "$app_url" ] && ! validated_app_owner_pair "$owner_url" "$app_url"; then
        pg_state_fail app_database_url
        return 1
      fi
      if [ "$PG_INSTALL_PENDING" = 1 ] && [ -n "$app_url" ]; then
        pg_state_fail install_pending_app
        return 1
      fi
      validate_persisted_backend_service || return 1
    else
      if [ -n "$app_url" ] && ! validated_app_owner_pair "$owner_url" "$app_url"; then
        pg_state_fail app_database_url
        return 1
      fi
      if [ -z "$app_url" ] && [ "$allow_fresh" = 1 ] &&
         [ -n "$caller_port" ]; then
        PG_PORT="$(normalized_pg_port "$caller_port")" || {
          pg_state_fail port
          return 1
        }
        owner_url="$(retarget_validated_owner_port "$owner_url" "$PG_PORT")" || {
          pg_state_fail database_url
          return 1
        }
        PG_STATE_REWRITE_OWNER=1
      else
        PG_PORT="$url_port"
      fi
      if [ -z "$app_url" ] && [ "$allow_fresh" = 1 ] &&
         ! fresh_owner_bootstrap_compatible "$owner_url"; then
        pg_state_fail fresh_owner_credentials
        return 1
      fi
      PG_PORT_EXPLICIT=1
      adopt_legacy_pg_backend "$force_native" "$allow_fresh" "$app_url" || return 1
    fi
    OWNER_DATABASE_URL="$owner_url"
  else
    [ "$allow_fresh" = 1 ] || { pg_state_fail install_required; return 1; }
    if [ -n "$caller_port" ]; then
      PG_PORT="$(normalized_pg_port "$caller_port")" || {
        pg_state_fail port
        return 1
      }
      PG_PORT_EXPLICIT=1
    else
      PG_PORT=5432
    fi
    select_fresh_pg_backend "$force_native" || return 1
    OWNER_DATABASE_URL="postgres://minime:minime@localhost:$PG_PORT/minime"
    PG_STATE_NEEDS_PERSIST=1
    PG_STATE_REWRITE_OWNER=1
    PG_LIFECYCLE_FRESH=1
    PG_INSTALL_PENDING=1
  fi

  MINIME_PG_BACKEND="$PG_BACKEND"
  MINIME_PG_PORT="$PG_PORT"
  DATABASE_URL="$OWNER_DATABASE_URL"
  export MINIME_PG_BACKEND MINIME_PG_PORT DATABASE_URL
  return 0
}

persist_pg_lifecycle() {
  local env_file="${1:-.env}" rewrite_owner="${2:-0}" tmp
  [ -f "$env_file" ] || return 1
  umask 077
  tmp="$(mktemp "${env_file}.pg.XXXXXX")" || return 1
  MINIME_PERSIST_PG_BACKEND="$PG_BACKEND" \
  MINIME_PERSIST_PG_PORT="$PG_PORT" \
  MINIME_PERSIST_PG_PENDING="$PG_INSTALL_PENDING" \
  MINIME_PERSIST_OWNER_URL="$OWNER_DATABASE_URL" \
  MINIME_PERSIST_REWRITE_OWNER="$rewrite_owner" \
  awk '
    /^[[:space:]]*#?[[:space:]]*MINIME_PG_BACKEND[[:space:]]*=/ {
      if (!seen_backend) print "MINIME_PG_BACKEND=" ENVIRON["MINIME_PERSIST_PG_BACKEND"]
      seen_backend=1; next
    }
    /^[[:space:]]*#?[[:space:]]*MINIME_PG_PORT[[:space:]]*=/ {
      if (!seen_port) print "MINIME_PG_PORT=" ENVIRON["MINIME_PERSIST_PG_PORT"]
      seen_port=1; next
    }
    /^[[:space:]]*#?[[:space:]]*MINIME_PG_INSTALL_PENDING[[:space:]]*=/ {
      if (!seen_pending) print "MINIME_PG_INSTALL_PENDING=" ENVIRON["MINIME_PERSIST_PG_PENDING"]
      seen_pending=1; next
    }
    /^[[:space:]]*(export[[:space:]]+)?DATABASE_URL[[:space:]]*=/ &&
      ENVIRON["MINIME_PERSIST_REWRITE_OWNER"] == "1" {
      if (!seen_owner) print "DATABASE_URL=" ENVIRON["MINIME_PERSIST_OWNER_URL"]
      seen_owner=1; next
    }
    { print }
    END {
      if (!seen_backend) print "MINIME_PG_BACKEND=" ENVIRON["MINIME_PERSIST_PG_BACKEND"]
      if (!seen_port) print "MINIME_PG_PORT=" ENVIRON["MINIME_PERSIST_PG_PORT"]
      if (!seen_pending) print "MINIME_PG_INSTALL_PENDING=" ENVIRON["MINIME_PERSIST_PG_PENDING"]
      if (ENVIRON["MINIME_PERSIST_REWRITE_OWNER"] == "1" && !seen_owner)
        print "DATABASE_URL=" ENVIRON["MINIME_PERSIST_OWNER_URL"]
    }
  ' "$env_file" > "$tmp" && chmod 600 "$tmp" && mv "$tmp" "$env_file" || {
    rm -f "$tmp"
    return 1
  }
  PG_STATE_NEEDS_PERSIST=0
}

# Something listening on either loopback family? Pure bash, no nc/psql needed.
port_open_host() { (exec 3<>"/dev/tcp/$1/$2") 2>/dev/null && exec 3>&- 3<&-; }
port_open() { port_open_host 127.0.0.1 "$1" || port_open_host ::1 "$1"; }

# Minime's own Postgres reachable with pgvector? Needs bun + node_modules (cheap, no psql).
pg_provisioned() {
  have bun && [ -d node_modules/postgres ] &&
    [ -n "$OWNER_DATABASE_URL" ] &&
    PROBE_URL="$OWNER_DATABASE_URL" bun --no-env-file scripts/pg-probe.ts >/dev/null 2>&1
}

# Full idempotent-bootstrap postcondition. This is deliberately stronger than the
# cheap pg_provisioned detector: both databases, both required extensions, and the
# fixed bootstrap role/ownership posture must be present through the exact owner URL.
pg_bootstrap_complete() {
  have bun && [ -d node_modules/postgres ] && [ -n "$OWNER_DATABASE_URL" ] &&
    MINIME_BOOTSTRAP_PROBE_URL="$OWNER_DATABASE_URL" bun --no-env-file -e '
      import postgres from "postgres";
      import { parseLocalPostgresUrl } from "./src/util/postgres-url";
      const raw = process.env.MINIME_BOOTSTRAP_PROBE_URL || "";
      const check = async (url, expected) => {
        const sql = postgres(url, { max: 1, connect_timeout: 4, onnotice: () => {} });
        try {
          const rows = await sql`
            select
              current_database() = ${expected} as database_ok,
              current_user <> ${"minime_app"} as owner_connection_ok,
              exists(select 1 from pg_extension where extname = ${"vector"}) as vector_ok,
              exists(select 1 from pg_extension where extname = ${"pgcrypto"}) as pgcrypto_ok,
              exists(
                select 1 from pg_roles
                where rolname = ${"minime"} and rolcanlogin and rolcreatedb and rolcreaterole
              ) as role_ok,
              exists(
                select 1 from pg_database d join pg_roles r on r.oid = d.datdba
                where d.datname = ${expected} and r.rolname = ${"minime"}
              ) as database_owner_ok
          `;
          const row = rows[0];
          return Boolean(row?.database_ok && row?.owner_connection_ok && row?.vector_ok &&
            row?.pgcrypto_ok && row?.role_ok && row?.database_owner_ok);
        } finally {
          await sql.end({ timeout: 1 }).catch(() => {});
        }
      };
      try {
        const owner = parseLocalPostgresUrl(raw, "minime");
        const testUrl = new URL(owner.url.toString());
        testUrl.pathname = "/minime_test";
        const ok = await check(owner.url.toString(), "minime") &&
          await check(testUrl.toString(), "minime_test");
        process.exit(ok ? 0 : 1);
      } catch { process.exit(1); }
    ' >/dev/null 2>&1
}

# Prove the exact persisted owner credentials/database before any bootstrap DDL. Unlike
# pg_provisioned, this intentionally does not require extensions that bootstrap may repair.
pg_owner_reachable() {
  have bun && [ -d node_modules/postgres ] && [ -n "$OWNER_DATABASE_URL" ] &&
    PROBE_URL="$OWNER_DATABASE_URL" bun --no-env-file -e '
      import postgres from "postgres";
      const sql = postgres(process.env.PROBE_URL || "", {
        max: 1, connect_timeout: 4, onnotice: () => {},
      });
      let ok = false;
      try {
        const rows = await sql`select current_database() as database, current_user as username`;
        ok = rows[0]?.database === "minime" && rows[0]?.username !== "minime_app";
      } catch {}
      finally { await sql.end({ timeout: 1 }).catch(() => {}); }
      process.exit(ok ? 0 : 1);
    ' >/dev/null 2>&1
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

ollama_api_url() {
  local api="$1" host port
  host="$OLLAMA_NORMALIZED_HOST"
  [ "$host" = "::1" ] && host="[::1]"
  if { [ "$OLLAMA_SCHEME" = http ] && [ "$OLLAMA_PORT" = 80 ]; } ||
     { [ "$OLLAMA_SCHEME" = https ] && [ "$OLLAMA_PORT" = 443 ]; }; then
    port=""
  else
    port=":$OLLAMA_PORT"
  fi
  printf '%s://%s%s%s%s' "$OLLAMA_SCHEME" "$host" "$port" "$OLLAMA_BASE_PATH" "$api"
}

private_ollama_workspace() {
  local prefix="$1"
  umask 077
  OLLAMA_WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/$prefix.XXXXXX")" || return 1
  trap 'rm -rf -- "$OLLAMA_WORK_DIR"' EXIT
  trap 'forward_ollama_signal HUP 129' HUP
  trap 'forward_ollama_signal INT 130' INT
  trap 'forward_ollama_signal TERM 143' TERM
  chmod 700 "$OLLAMA_WORK_DIR" || return 1
}

forward_ollama_signal() {
  local signal="$1" code="$2"
  if [ -n "${OLLAMA_CURL_PID:-}" ]; then
    builtin kill -s "$signal" "$OLLAMA_CURL_PID" 2>/dev/null || true
    builtin wait "$OLLAMA_CURL_PID" 2>/dev/null || true
  fi
  exit "$code"
}

reserve_ollama_output() {
  OLLAMA_OUTPUT="$OLLAMA_WORK_DIR/response.json"
  OLLAMA_ERROR="$OLLAMA_WORK_DIR/curl.stderr"
  OLLAMA_STATUS="$OLLAMA_WORK_DIR/http.status"
  : > "$OLLAMA_OUTPUT" || return 1
  : > "$OLLAMA_ERROR" || return 1
  : > "$OLLAMA_STATUS" || return 1
  chmod 600 "$OLLAMA_OUTPUT" "$OLLAMA_ERROR" "$OLLAMA_STATUS" || return 1
}

ollama_request() {
  local method="$1" api="$2" data="$3" output="$4" url status timeout curl_rc
  url="$(ollama_api_url "$api")"
  timeout="${MINIME_OLLAMA_CURL_TIMEOUT:-30}"
  [[ "$timeout" =~ ^[1-9][0-9]*$ ]] || timeout=30
  local -a args
  args=(-q --noproxy '*' --proxy '' --silent --show-error --max-time "$timeout"
    --request "$method" --header "Host: $OLLAMA_HOST_HEADER"
    --output "$output" --write-out '%{http_code}')
  if [ "$OLLAMA_NORMALIZED_HOST" = localhost ]; then
    args+=(--resolve "localhost:$OLLAMA_PORT:127.0.0.1")
  fi
  if [ -n "$data" ]; then
    args+=(--header 'content-type: application/json' --data-binary "$data")
  fi
  OLLAMA_CURL_PID=""
  env -u HTTP_PROXY -u http_proxy -u HTTPS_PROXY -u https_proxy \
    -u ALL_PROXY -u all_proxy \
    curl "${args[@]}" "$url" >"$OLLAMA_STATUS" 2>"$OLLAMA_ERROR" &
  OLLAMA_CURL_PID=$!
  if wait "$OLLAMA_CURL_PID"; then
    curl_rc=0
  else
    curl_rc=$?
  fi
  OLLAMA_CURL_PID=""
  [ "$curl_rc" -eq 0 ] || return "$curl_rc"
  status="$(<"$OLLAMA_STATUS")"
  case "$status" in 2??) return 0 ;; *) return 1 ;; esac
}

valid_ollama_model() {
  [ -n "$1" ] && [[ "$1" != *[!A-Za-z0-9._:/-]* ]]
}

ollama_reachable() (
  private_ollama_workspace minime-ollama-tags || exit 1
  reserve_ollama_output || exit 1
  ollama_request GET /api/tags "" "$OLLAMA_OUTPUT"
)

ollama_has_model() (
  local model="$1" tags
  valid_ollama_model "$model" || exit 1
  private_ollama_workspace minime-ollama-model || exit 1
  reserve_ollama_output || exit 1
  ollama_request GET /api/tags "" "$OLLAMA_OUTPUT" || exit 1
  tags="$(tr -d '\r\n\t ' < "$OLLAMA_OUTPUT")"
  printf '%s' "$tags" | grep -Fq "\"name\":\"$model\"" ||
    printf '%s' "$tags" | grep -Fq "\"name\":\"$model:"
)

json_string() {
  local value="$1"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  printf '"%s"' "$value"
}

ollama_pull_model() (
  local model="$1" timeout="$2" payload
  valid_ollama_model "$model" || exit 1
  private_ollama_workspace minime-ollama-pull || exit 1
  reserve_ollama_output || exit 1
  payload="{\"name\":$(json_string "$model"),\"stream\":false}"
  MINIME_OLLAMA_CURL_TIMEOUT="$timeout" \
    ollama_request POST /api/pull "$payload" "$OLLAMA_OUTPUT"
)

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

if [ "${MINIME_LIB_SKIP_RESOLVE:-0}" != "1" ]; then
  resolve_ollama_url
fi
