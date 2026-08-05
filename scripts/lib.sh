# shellcheck shell=bash
# Shared helpers for scripts/up.sh and scripts/install.sh. Source, don't execute.

PG_PORT="${MINIME_PG_PORT:-5432}"
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
