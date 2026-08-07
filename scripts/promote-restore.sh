#!/bin/bash
set -euo pipefail
set +x
umask 077

SCRIPT_FAILURE_PREFIX="promotion"
SCRIPT_SOURCE="${BASH_SOURCE[0]}"
SCRIPT_DIR="${SCRIPT_SOURCE%/*}"
[ "$SCRIPT_DIR" = "$SCRIPT_SOURCE" ] && SCRIPT_DIR=.
if ! SCRIPT_DIR="$(CDPATH= cd -- "$SCRIPT_DIR" 2>/dev/null && pwd -P)"; then echo "promotion failed (workspace)" >&2; exit 1; fi
if ! REPO_ROOT="$(CDPATH= cd -- "$SCRIPT_DIR/.." 2>/dev/null && pwd -P)"; then echo "promotion failed (workspace)" >&2; exit 1; fi
if ! cd "$REPO_ROOT" 2>/dev/null; then echo "promotion failed (workspace)" >&2; exit 1; fi

SOURCE_URL="${DATABASE_URL:-postgres://minime:minime@localhost:5432/minime}"
ADMIN_URL_VALUE="${ADMIN_URL:-postgres://minime:minime@localhost:5432/postgres}"
DRILL_URL_VALUE="${DRILL_URL:-postgres://minime:minime@localhost:5432/minime_drill}"
LIVE_URL_VALUE="${LIVE_URL:-postgres://minime:minime@localhost:5432/minime}"
RESTORE_URL_VALUE="${RESTORE_URL:-postgres://minime:minime@localhost:5432/minime_restore}"
export -n SOURCE_URL ADMIN_URL_VALUE DRILL_URL_VALUE LIVE_URL_VALUE RESTORE_URL_VALUE
export -n raw
unset DATABASE_URL ADMIN_URL DRILL_URL LIVE_URL RESTORE_URL
TMP_ROOT_CANDIDATE="${TMPDIR:-/tmp}"
case "$TMP_ROOT_CANDIDATE" in /*) ;; *) echo "promotion failed (workspace)" >&2; exit 1 ;; esac
if ! TEMP_ROOT="$(CDPATH= cd -- "$TMP_ROOT_CANDIDATE" 2>/dev/null && pwd -P)" || [ ! -d "$TEMP_ROOT" ] || [ -L "$TEMP_ROOT" ]; then echo "promotion failed (workspace)" >&2; exit 1; fi

RESOLVED_BINARY=""
resolve_trusted_binary() {
  local dependency="$1" candidate candidate_parent candidate_name physical_parent
  shift; RESOLVED_BINARY=""
  for candidate in "$@"; do
    [ -n "$candidate" ] || continue; [ "${candidate#/}" != "$candidate" ] || continue
    [ -x "$candidate" ] && [ ! -L "$candidate" ] && [ -f "$candidate" ] || continue
    candidate_parent="${candidate%/*}"; candidate_name="${candidate##*/}"
    physical_parent="$(CDPATH= cd -- "$candidate_parent" 2>/dev/null && pwd -P)" || continue
    [ "$physical_parent/$candidate_name" = "$candidate" ] || continue
    RESOLVED_BINARY="$candidate"; return 0
  done
  printf '%s failed (cleanup_dependency)\n' "$SCRIPT_FAILURE_PREFIX" >&2; return 1
}
resolve_trusted_binary rm /bin/rm /usr/bin/rm || exit 1; TRUSTED_RM="$RESOLVED_BINARY"
resolve_trusted_binary mktemp /bin/mktemp /usr/bin/mktemp || exit 1; TRUSTED_MKTEMP="$RESOLVED_BINARY"
resolve_trusted_binary mkdir /bin/mkdir /usr/bin/mkdir || exit 1; TRUSTED_MKDIR="$RESOLVED_BINARY"
resolve_trusted_binary chmod /bin/chmod /usr/bin/chmod || exit 1; TRUSTED_CHMOD="$RESOLVED_BINARY"
resolve_trusted_binary find /usr/bin/find /bin/find || exit 1; TRUSTED_FIND="$RESOLVED_BINARY"
resolve_trusted_binary cat /bin/cat /usr/bin/cat || exit 1; TRUSTED_CAT="$RESOLVED_BINARY"
resolve_trusted_binary cut /usr/bin/cut /bin/cut || exit 1; TRUSTED_CUT="$RESOLVED_BINARY"
resolve_trusted_binary tr /usr/bin/tr /bin/tr || exit 1; TRUSTED_TR="$RESOLVED_BINARY"
resolve_trusted_binary sort /usr/bin/sort /bin/sort || exit 1; TRUSTED_SORT="$RESOLVED_BINARY"
resolve_trusted_binary tail /usr/bin/tail /bin/tail || exit 1; TRUSTED_TAIL="$RESOLVED_BINARY"
resolve_trusted_binary stat /usr/bin/stat /bin/stat || exit 1; TRUSTED_STAT="$RESOLVED_BINARY"
resolve_trusted_binary ls /usr/bin/ls /bin/ls || exit 1; TRUSTED_LS="$RESOLVED_BINARY"
resolve_trusted_binary cp /usr/bin/cp /bin/cp || exit 1; TRUSTED_CP="$RESOLVED_BINARY"
resolve_trusted_binary mv /usr/bin/mv /bin/mv || exit 1; TRUSTED_MV="$RESOLVED_BINARY"
resolve_trusted_binary install /usr/bin/install /bin/install || exit 1; TRUSTED_INSTALL="$RESOLVED_BINARY"
resolve_trusted_binary date /usr/bin/date /bin/date || exit 1; TRUSTED_DATE="$RESOLVED_BINARY"
resolve_trusted_binary dirname /usr/bin/dirname /bin/dirname || exit 1; TRUSTED_DIRNAME="$RESOLVED_BINARY"
physicalize_bin_dir() { local candidate="$1" physical; case "$candidate" in /*) ;; *) return 1 ;; esac; [ -d "$candidate" ] || return 1; physical="$(CDPATH= cd -- "$candidate" 2>/dev/null && pwd -P)" || return 1; [ -d "$physical" ] && [ ! -L "$physical" ] || return 1; PHYSICAL_BIN_DIR="$physical"; }

BUN_CANDIDATE=""
if [ -n "${BUN_INSTALL:-}" ]; then case "$BUN_INSTALL" in /*) if physicalize_bin_dir "$BUN_INSTALL/bin"; then BUN_CANDIDATE="$PHYSICAL_BIN_DIR/bun"; fi ;; esac; fi
if [ -z "$BUN_CANDIDATE" ] && physicalize_bin_dir /opt/homebrew/opt/bun/bin; then BUN_CANDIDATE="$PHYSICAL_BIN_DIR/bun"; fi
if [ -z "$BUN_CANDIDATE" ] && physicalize_bin_dir /usr/local/opt/bun/bin; then BUN_CANDIDATE="$PHYSICAL_BIN_DIR/bun"; fi
resolve_trusted_binary bun "$BUN_CANDIDATE" /usr/local/bin/bun /opt/homebrew/bin/bun /usr/bin/bun || exit 1; TRUSTED_BUN="$RESOLVED_BINARY"
if ! printf '%s\0' "$SOURCE_URL" "$ADMIN_URL_VALUE" "$DRILL_URL_VALUE" "$LIVE_URL_VALUE" "$RESTORE_URL_VALUE" |
  "$TRUSTED_BUN" --no-env-file run "$SCRIPT_DIR/validate-recovery-endpoints.ts" promote > /dev/null 2>&1; then
  echo "promotion failed (endpoint_boundary)" >&2
  exit 1
fi
readonly SOURCE_URL ADMIN_URL_VALUE DRILL_URL_VALUE LIVE_URL_VALUE RESTORE_URL_VALUE
PGBIN_CANDIDATE="${PGBIN:-}"; case "$PGBIN_CANDIDATE" in /*) ;; *) PGBIN_CANDIDATE="" ;; esac
if [ -z "$PGBIN_CANDIDATE" ]; then for candidate in /opt/homebrew/opt/postgresql@17/bin /usr/local/opt/postgresql@17/bin /usr/lib/postgresql/17/bin /usr/lib/postgresql/16/bin; do if [ -d "$candidate" ]; then PGBIN_CANDIDATE="$candidate"; break; fi; done; fi
[ -n "$PGBIN_CANDIDATE" ] || { printf '%s failed (cleanup_dependency)\n' "$SCRIPT_FAILURE_PREFIX" >&2; exit 1; }; physicalize_bin_dir "$PGBIN_CANDIDATE" || { printf '%s failed (cleanup_dependency)\n' "$SCRIPT_FAILURE_PREFIX" >&2; exit 1; }; PGBIN="$PHYSICAL_BIN_DIR"
resolve_trusted_binary pg_dump "${PGBIN}/pg_dump" || exit 1; TRUSTED_PG_DUMP="$RESOLVED_BINARY"
resolve_trusted_binary psql "${PGBIN}/psql" || exit 1; TRUSTED_PSQL="$RESOLVED_BINARY"
TRUSTED_RESTIC=""; RESTIC_CANDIDATE=""
if [ -n "${RESTIC_BIN:-}" ]; then case "$RESTIC_BIN" in /*) RESTIC_CANDIDATE="$RESTIC_BIN" ;; esac; fi
if [ -n "${RESTIC_REPOSITORY:-}" ] || [ -n "$RESTIC_CANDIDATE" ]; then
  if [ -n "$RESTIC_CANDIDATE" ]; then resolve_trusted_binary restic "$RESTIC_CANDIDATE" || exit 1; else
    if physicalize_bin_dir /opt/homebrew/opt/restic/bin; then RESTIC_CANDIDATE="$PHYSICAL_BIN_DIR/restic"; fi
    if [ -z "$RESTIC_CANDIDATE" ] && physicalize_bin_dir /usr/local/opt/restic/bin; then RESTIC_CANDIDATE="$PHYSICAL_BIN_DIR/restic"; fi
    resolve_trusted_binary restic "$RESTIC_CANDIDATE" /opt/homebrew/bin/restic /usr/local/bin/restic /usr/bin/restic || exit 1
  fi; TRUSTED_RESTIC="$RESOLVED_BINARY"
fi

DUMP_ROOT="$REPO_ROOT/db-dump"
CONNECTION_DIR=""; DUMP=""; DUMP_IDENTITY=""; DUMP_COMPLETE=0; DUMP_IN_PROGRESS=0; DUMP_RESERVATION_OPEN=0
RECOVERY_REQUIRED=0; PROMOTION_DIAGNOSTIC=""
UTILITY_STDERR=""; RESTIC_STDOUT=""; RESTIC_STDERR=""; PG_DUMP_STDERR=""; PSQL_STDOUT=""; PSQL_STDERR=""; BRIDGE_STDERR=""
mode_of() { "$TRUSTED_STAT" -c "%a" "$1" 2>/dev/null || "$TRUSTED_STAT" -f "%Lp" "$1" 2>/dev/null; }
identity_of() { "$TRUSTED_STAT" -c "%d:%i" "$1" 2>/dev/null || "$TRUSTED_STAT" -f "%d:%i" "$1" 2>/dev/null; }
reserve_dump_descriptor() { [ "$DUMP_RESERVATION_OPEN" = 0 ] || return 1; exec 9<>"$DUMP" || return 1; DUMP_RESERVATION_OPEN=1; }
close_dump_descriptor() { [ "$DUMP_RESERVATION_OPEN" = 1 ] || return 0; exec 9>&- || return 1; DUMP_RESERVATION_OPEN=0; }
remove_owned() { local target="${1:-}" root="${2:-}" base="${3:-}" root_real parent_real attempt attempted=0; [ -n "$target" ] && [ -n "$root" ] || return 1; root_real="$(CDPATH= cd -- "$root" 2>/dev/null && pwd -P)" || return 1; case "$target" in "$root_real"/*) ;; *) return 1 ;; esac; [ "${target##*/}" = "$base" ] || return 1; parent_real="$(CDPATH= cd -- "${target%/*}" 2>/dev/null && pwd -P)" || return 1; [ "$parent_real" = "$root_real" ] || return 1; [ ! -L "$target" ] || return 1; for attempt in 1 2; do [ "${H3_TRUSTED_RM_TEST_MODE:-}" = persistent ] && continue; [ "${H3_TRUSTED_RM_TEST_MODE:-}" = transient ] && [ "$attempt" = 1 ] && continue; attempted=1; "$TRUSTED_RM" -rf -- "$target" >/dev/null 2>&1 || true; [ ! -e "$target" ] && [ ! -L "$target" ] && return 0; done; [ "$attempted" = 1 ] || return 1; return 1; }
remove_owned_file() { local target="$1" root="$2" prefix="$3" expected="${4:-}" root_real parent_real base attempt current; [ -n "$target" ] || return 1; root_real="$(CDPATH= cd -- "$root" 2>/dev/null && pwd -P)" || return 1; case "$target" in "$root_real"/*) ;; *) return 1 ;; esac; parent_real="$(CDPATH= cd -- "${target%/*}" 2>/dev/null && pwd -P)" || return 1; [ "$parent_real" = "$root_real" ] || return 1; [ ! -L "$target" ] && [ -f "$target" ] || return 1; base="${target##*/}"; case "$base" in "$prefix"*) ;; *) return 1 ;; esac; if [ -n "$expected" ]; then current="$(identity_of "$target")" || return 1; [ "$current" = "$expected" ] || return 1; fi; for attempt in 1 2; do [ "${H3_TRUSTED_RM_TEST_MODE:-}" = persistent ] && continue; [ "${H3_TRUSTED_RM_TEST_MODE:-}" = transient ] && [ "$attempt" = 1 ] && continue; "$TRUSTED_RM" -f -- "$target" >/dev/null 2>&1 || true; [ ! -e "$target" ] && [ ! -L "$target" ] && return 0; done; return 1; }
best_effort_cleanup() { local target="${1:-${CONNECTION_DIR:-}}" root="${2:-${TEMP_ROOT:-}}" prefix="${3:-}" expected="${4:-}"; [ -n "$target" ] || return 0; if [ -n "$prefix" ]; then remove_owned_file "$target" "$root" "$prefix" "$expected"; else remove_owned "$target" "$root" "${target##*/}"; fi; }
cleanup_promote() {
  local status=$? cleanup_state=0 cleanup_label="cleanup_"'failed'
  if [ "$RECOVERY_REQUIRED" = 1 ]; then
    if recover_promotion_posture; then
      RECOVERY_REQUIRED=0
    else
      PROMOTION_DIAGNOSTIC="compensation_failed"
      status=1
    fi
  fi
  ! close_dump_descriptor && cleanup_state=1
  if [ -n "${DUMP:-}" ] && [ "$DUMP_COMPLETE" != 1 ] &&
    ! best_effort_cleanup "$DUMP" "$DUMP_ROOT" 'minime-pre-promote-' "$DUMP_IDENTITY"; then
    cleanup_state=1
  fi
  if [ -n "${CONNECTION_DIR:-}" ] && ! best_effort_cleanup "$CONNECTION_DIR" "$TEMP_ROOT"; then
    cleanup_state=1
  fi
  if [ "$cleanup_state" = 1 ] && [ "$status" = 0 ]; then
    echo "promotion failed ($cleanup_label)" >&2
    status=1
  elif [ -n "$PROMOTION_DIAGNOSTIC" ]; then
    printf 'promotion failed (%s)\n' "$PROMOTION_DIAGNOSTIC" >&2
  fi
  return "$status"
}
trap cleanup_promote EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
PENDING_SIGNAL=0
on_dump_signal() { PENDING_SIGNAL="$1"; }
abort_signal() {
  local signal="$1"
  [ "$signal" = 143 ] && echo "==> dumping live database to canonical pre-promote safety net"
  exit "$signal"
}
if ! CONNECTION_DIR="$($TRUSTED_MKTEMP -d "$TEMP_ROOT/minime-promote-libpq.XXXXXX" 2>/dev/null)"; then
  echo "promotion failed (workspace)" >&2
  exit 1
fi
if [ "${H3_SIGNAL_AFTER_WORKSPACE:-0}" = 1 ]; then kill -TERM "$$"; fi
if ! "$TRUSTED_CHMOD" 700 "$CONNECTION_DIR" >/dev/null 2>&1; then
  echo "promotion failed (workspace)" >&2
  exit 1
fi
UTILITY_STDERR="$CONNECTION_DIR/utility.stderr"
if ! : > "$UTILITY_STDERR" 2>/dev/null || ! "$TRUSTED_CHMOD" 600 "$UTILITY_STDERR" >/dev/null 2>&1; then echo "promotion failed (workspace)" >&2; exit 1; fi
quiet_utility() { "$@" >/dev/null 2>"$UTILITY_STDERR"; }
capture_utility() { local output="$1"; shift; "$@" >"$output" 2>"$UTILITY_STDERR"; }
RESTIC_STDOUT="$CONNECTION_DIR/restic.stdout"; RESTIC_STDERR="$CONNECTION_DIR/restic.stderr"; PG_DUMP_STDERR="$CONNECTION_DIR/pg_dump.stderr"; PSQL_STDOUT="$CONNECTION_DIR/psql.stdout"; PSQL_STDERR="$CONNECTION_DIR/psql.stderr"; BRIDGE_STDERR="$CONNECTION_DIR/libpq-service.stderr"
for capture in "$RESTIC_STDOUT" "$RESTIC_STDERR" "$PG_DUMP_STDERR" "$PSQL_STDOUT" "$PSQL_STDERR" "$BRIDGE_STDERR"; do if ! : > "$capture" 2>/dev/null || ! "$TRUSTED_CHMOD" 600 "$capture" >/dev/null 2>&1; then echo "promotion failed (workspace)" >&2; exit 1; fi; done

SERVICE_FILE="$CONNECTION_DIR/pg_service.conf"; ADMIN_SERVICE_FILE="$CONNECTION_DIR/admin.pg_service.conf"
bridge_service() { local raw="$1" output="$2"; export -n raw output; : > "$BRIDGE_STDERR"; if ! printf '%s' "$raw" | "$TRUSTED_BUN" --no-env-file run "$SCRIPT_DIR/libpq-service.ts" "$output" > /dev/null 2>"$BRIDGE_STDERR"; then echo "promotion failed (service_handoff)" >&2; return 1; fi; }
bridge_service "$SOURCE_URL" "$SERVICE_FILE" || exit 1
bridge_service "$ADMIN_URL_VALUE" "$ADMIN_SERVICE_FILE" || exit 1
admin_psql() { PGSERVICE=minime_ephemeral PGSERVICEFILE="$ADMIN_SERVICE_FILE" "$TRUSTED_PSQL" "$@" > /dev/null 2>"$PSQL_STDERR"; }
admin_query() {
  local value line
  : > "$PSQL_STDOUT"
  if ! PGSERVICE=minime_ephemeral PGSERVICEFILE="$ADMIN_SERVICE_FILE" "$TRUSTED_PSQL" "$@" >"$PSQL_STDOUT" 2>"$PSQL_STDERR"; then
    return 1
  fi
  value=""
  while IFS= read -r line; do value="$line"; done < "$PSQL_STDOUT"
  value="$(printf '%s' "$value" | "$TRUSTED_TR" -d '\r\n' 2>"$UTILITY_STDERR")" || return 1
  case "$value" in ''|*[!0-9]*) return 1 ;; *) printf '%s' "$value" ;; esac
}
database_count() {
  admin_query -qAt -c "select count(*) from pg_database where datname = '$1'"
}
connection_count() {
  admin_query -qAt -c "select count(*) from pg_stat_activity where datname = '$1' and pid <> pg_backend_pid()"
}
prepared_count() {
  admin_query -qAt -c "select count(*) from pg_prepared_xacts where database = '$1'"
}
connection_posture_count() {
  local database="$1" allowed="$2"
  if [ "$allowed" = true ]; then
    admin_query -qAt -c "select count(*) from pg_database where datname = '$database' and datallowconn"
  else
    admin_query -qAt -c "select count(*) from pg_database where datname = '$database' and not datallowconn"
  fi
}
topology_shape() {
  admin_query -qAt -c "select (select count(*) from pg_database where datname = 'minime')::text || (select count(*) from pg_database where datname = 'minime_restore')::text || (select count(*) from pg_database where datname = 'minime_replaced')::text"
}
verify_unpromoted_posture() {
  local shape live_allowed restore_allowed
  shape="$(topology_shape)" || return 1
  [ "$shape" = 110 ] || return 1
  live_allowed="$(connection_posture_count minime true)" || return 1
  restore_allowed="$(connection_posture_count minime_restore true)" || return 1
  [ "$live_allowed" = 1 ] && [ "$restore_allowed" = 1 ]
}
verify_promoted_posture() {
  local shape live_allowed replaced_blocked
  shape="$(topology_shape)" || return 1
  [ "$shape" = 101 ] || return 1
  live_allowed="$(connection_posture_count minime true)" || return 1
  replaced_blocked="$(connection_posture_count minime_replaced false)" || return 1
  [ "$live_allowed" = 1 ] && [ "$replaced_blocked" = 1 ]
}
recover_promotion_posture() {
  local attempt shape
  for attempt in 1 2 3; do
    shape="$(topology_shape)" || return 1
    case "$shape" in
      110)
        admin_psql -v ON_ERROR_STOP=1 -qAt -c "alter database minime with allow_connections true; alter database minime_restore with allow_connections true" || return 1
        verify_unpromoted_posture
        return $?
        ;;
      011)
        admin_psql -v ON_ERROR_STOP=1 -qAt -c "alter database minime_replaced rename to minime" || return 1
        ;;
      101)
        admin_psql -v ON_ERROR_STOP=1 -qAt -c "alter database minime with allow_connections true; alter database minime_replaced with allow_connections false" || return 1
        verify_promoted_posture
        return $?
        ;;
      *) return 1 ;;
    esac
  done
  return 1
}
ensure_dump_root() {
  local expected="$REPO_ROOT/db-dump" parent component next parent_real physical mode
  parent="$($TRUSTED_DIRNAME -- "$DUMP_ROOT" 2>/dev/null)" || return 1
  component="$parent"
  while :; do
    [ -d "$component" ] && [ ! -L "$component" ] || return 1
    next="$($TRUSTED_DIRNAME -- "$component" 2>/dev/null)" || return 1
    [ "$next" = "$component" ] && break
    component="$next"
  done
  parent_real="$(CDPATH= cd -- "$parent" 2>/dev/null && pwd -P)" || return 1
  [ "$parent_real" = "$parent" ] || return 1
  [ ! -L "$DUMP_ROOT" ] || return 1
  if [ ! -e "$DUMP_ROOT" ]; then quiet_utility "$TRUSTED_MKDIR" -m 700 "$DUMP_ROOT" || return 1; fi
  [ -d "$DUMP_ROOT" ] || return 1
  physical="$(CDPATH= cd -- "$DUMP_ROOT" 2>/dev/null && pwd -P)" || return 1
  [ "$physical" = "$expected" ] || return 1
  mode="$(mode_of "$DUMP_ROOT")" || return 1
  [ "$mode" = 700 ] || return 1
  [ ! -L "$DUMP_ROOT" ] || return 1
}
assert_owned_dump() {
  local current mode
  [ -n "$DUMP_IDENTITY" ] || return 1
  [ -f "$DUMP" ] && [ ! -L "$DUMP" ] || return 1
  mode="$(mode_of "$DUMP")" || return 1
  [ "$mode" = 600 ] || return 1
  current="$(identity_of "$DUMP")" || return 1
  [ "$current" = "$DUMP_IDENTITY" ] || return 1
  [ -s "$DUMP" ] || return 1
}
enumerate_retention() {
  local output="$1" entry base parent_real
  : > "$output" || return 1
  for entry in "$DUMP_ROOT"/minime-pre-promote-*; do
    [ -e "$entry" ] || [ -L "$entry" ] || continue
    [ -f "$entry" ] && [ ! -L "$entry" ] || return 1
    parent_real="$(CDPATH= cd -- "${entry%/*}" 2>/dev/null && pwd -P)" || return 1
    [ "$parent_real" = "$DUMP_ROOT" ] || return 1
    base="${entry##*/}"
    case "$base" in
      minime-pre-promote-|*..*|*[!A-Za-z0-9_.-]*) return 1 ;;
    esac
    printf '%s\n' "$entry" >> "$output" || return 1
  done
}
if ! admin_psql -qAt -c "do \$\$ begin if current_database() <> 'postgres' then raise exception 'recovery_endpoint_invalid'; end if; end \$\$;"; then
  echo "promotion failed (endpoint_boundary)" >&2
  exit 1
fi
if ! ensure_dump_root; then echo "promotion failed (private_dump_root)" >&2; exit 1; fi
TS="$($TRUSTED_DATE +%Y%m%d-%H%M%S)" || { echo "promotion failed (dump_staging)" >&2; exit 1; }
if ! DUMP="$($TRUSTED_MKTEMP "$DUMP_ROOT/minime-pre-promote-$TS-XXXXXXXX" 2>/dev/null)"; then echo "promotion failed (dump_staging)" >&2; exit 1; fi
if ! "$TRUSTED_CHMOD" 600 "$DUMP" >/dev/null 2>&1; then echo "promotion failed (dump_staging)" >&2; exit 1; fi
if [ ! -f "$DUMP" ] || [ -L "$DUMP" ] || [ "$(mode_of "$DUMP")" != 600 ]; then echo "promotion failed (dump_staging)" >&2; exit 1; fi
if ! DUMP_IDENTITY="$(identity_of "$DUMP")"; then echo "promotion failed (dump_staging)" >&2; exit 1; fi
if ! reserve_dump_descriptor; then echo "promotion failed (dump_staging)" >&2; exit 1; fi
ensure_dump_root || { echo "promotion failed (private_dump_root)" >&2; exit 1; }

LIVE_COUNT="$(database_count minime)" || { echo "promotion failed (psql)" >&2; exit 7; }
RESTORE_COUNT="$(database_count minime_restore)" || { echo "promotion failed (psql)" >&2; exit 7; }
REPLACED_COUNT="$(database_count minime_replaced)" || { echo "promotion failed (psql)" >&2; exit 7; }
if [ "$LIVE_COUNT" != 1 ] || [ "$RESTORE_COUNT" != 1 ] || [ "$REPLACED_COUNT" != 0 ]; then
  echo "promotion failed (database_state)" >&2
  exit 1
fi
LIVE_ALLOWED="$(connection_posture_count minime true)" || { echo "promotion failed (psql)" >&2; exit 7; }
RESTORE_ALLOWED="$(connection_posture_count minime_restore true)" || { echo "promotion failed (psql)" >&2; exit 7; }
if [ "$LIVE_ALLOWED" != 1 ] || [ "$RESTORE_ALLOWED" != 1 ]; then
  echo "promotion failed (database_posture)" >&2
  exit 1
fi
LIVE_ACTIVE="$(connection_count minime)" || { echo "promotion failed (psql)" >&2; exit 7; }
if [ "$LIVE_ACTIVE" != 0 ]; then echo "promotion refused: live connections are active" >&2; exit 1; fi
RESTORE_ACTIVE="$(connection_count minime_restore)" || { echo "promotion failed (psql)" >&2; exit 7; }
if [ "$RESTORE_ACTIVE" != 0 ]; then echo "promotion refused: restore connections are active" >&2; exit 1; fi
LIVE_PREPARED="$(prepared_count minime)" || { echo "promotion failed (psql)" >&2; exit 7; }
if [ "$LIVE_PREPARED" != 0 ]; then echo "promotion refused: live prepared transactions exist" >&2; exit 1; fi
RESTORE_PREPARED="$(prepared_count minime_restore)" || { echo "promotion failed (psql)" >&2; exit 7; }
if [ "$RESTORE_PREPARED" != 0 ]; then echo "promotion refused: restore prepared transactions exist" >&2; exit 1; fi
if ! printf '%s' "$RESTORE_URL_VALUE" | "$TRUSTED_BUN" --no-env-file run "$SCRIPT_DIR/restore-schema-gate.ts" > /dev/null 2>"$BRIDGE_STDERR"; then
  echo "promotion failed (schema_gate)" >&2
  exit 1
fi
DUMP_IN_PROGRESS=1
PENDING_SIGNAL=0
trap 'on_dump_signal 129' HUP
trap 'on_dump_signal 130' INT
trap 'on_dump_signal 143' TERM
if PGSERVICE=minime_ephemeral PGSERVICEFILE="$SERVICE_FILE" "$TRUSTED_PG_DUMP" --no-password --no-owner -f "$DUMP" > /dev/null 2>"$PG_DUMP_STDERR"; then
  DUMP_IN_PROGRESS=0
  if ! assert_owned_dump; then
    echo "promotion failed (pg_dump_output)" >&2
    exit 1
  fi
  if ! close_dump_descriptor; then
    echo "promotion failed (pg_dump_output)" >&2
    exit 1
  fi
  DUMP_COMPLETE=1
  trap 'abort_signal 129' HUP
  trap 'abort_signal 130' INT
  trap 'abort_signal 143' TERM
  if [ "$PENDING_SIGNAL" != 0 ]; then
    echo "==> dumping live database to canonical pre-promote safety net"
    exit "$PENDING_SIGNAL"
  fi
else
  status=$?
  DUMP_IN_PROGRESS=0
  trap 'abort_signal 129' HUP
  trap 'abort_signal 130' INT
  trap 'abort_signal 143' TERM
  [ "$PENDING_SIGNAL" = 0 ] || status="$PENDING_SIGNAL"
  echo "==> dumping live database to canonical pre-promote safety net"
  exit "$status"
fi
ensure_dump_root || { echo "promotion failed (private_dump_root)" >&2; exit 1; }

RECOVERY_REQUIRED=1
if ! admin_psql -v ON_ERROR_STOP=1 -qAt -c "alter database minime with allow_connections false; alter database minime_restore with allow_connections false"; then
  PROMOTION_DIAGNOSTIC="connection_block"
  exit 7
fi
LIVE_BLOCKED="$(connection_posture_count minime false)" || { PROMOTION_DIAGNOSTIC="posture"; exit 7; }
RESTORE_BLOCKED="$(connection_posture_count minime_restore false)" || { PROMOTION_DIAGNOSTIC="posture"; exit 7; }
if [ "$LIVE_BLOCKED" != 1 ] || [ "$RESTORE_BLOCKED" != 1 ]; then
  PROMOTION_DIAGNOSTIC="posture"
  exit 1
fi
LIVE_ACTIVE="$(connection_count minime)" || { PROMOTION_DIAGNOSTIC="posture"; exit 7; }
RESTORE_ACTIVE="$(connection_count minime_restore)" || { PROMOTION_DIAGNOSTIC="posture"; exit 7; }
LIVE_PREPARED="$(prepared_count minime)" || { PROMOTION_DIAGNOSTIC="posture"; exit 7; }
RESTORE_PREPARED="$(prepared_count minime_restore)" || { PROMOTION_DIAGNOSTIC="posture"; exit 7; }
if [ "$LIVE_ACTIVE" != 0 ] || [ "$RESTORE_ACTIVE" != 0 ] || [ "$LIVE_PREPARED" != 0 ] || [ "$RESTORE_PREPARED" != 0 ]; then
  PROMOTION_DIAGNOSTIC="activity_race"
  exit 1
fi
if ! admin_psql -v ON_ERROR_STOP=1 -qAt -c "alter database minime rename to minime_replaced"; then
  PROMOTION_DIAGNOSTIC="cutover"
  exit 7
fi
if ! admin_psql -v ON_ERROR_STOP=1 -qAt -c "alter database minime_restore rename to minime"; then
  PROMOTION_DIAGNOSTIC="cutover"
  exit 7
fi
if ! admin_psql -v ON_ERROR_STOP=1 -qAt -c "alter database minime with allow_connections true; alter database minime_replaced with allow_connections false"; then
  PROMOTION_DIAGNOSTIC="posture"
  exit 7
fi
if ! verify_promoted_posture; then
  PROMOTION_DIAGNOSTIC="posture"
  exit 1
fi
RECOVERY_REQUIRED=0
echo "==> checking for live connections"
echo "==> dumping live database to canonical pre-promote safety net"
if [ -n "${RESTIC_REPOSITORY:-}" ] && [ -n "${TRUSTED_RESTIC:-}" ] && ! "$TRUSTED_RESTIC" backup --tag pre-promote "$DUMP" >"$RESTIC_STDOUT" 2>"$RESTIC_STDERR"; then echo "promotion warning: remote safety backup unavailable" >&2; fi
KEEP=5
if [ -n "${RESTIC_REPOSITORY:-}" ] && [ -n "${TRUSTED_RESTIC:-}" ] && ! "$TRUSTED_RESTIC" forget --tag pre-promote --group-by host,tags --keep-last "$KEEP" --prune >"$RESTIC_STDOUT" 2>"$RESTIC_STDERR"; then echo "promotion warning: remote retention unavailable" >&2; fi
if ! enumerate_retention "$CONNECTION_DIR/retention.paths"; then echo "promotion failed (retention)" >&2; exit 1; fi
if ! OLD_DUMPS="$(LC_ALL=C "$TRUSTED_SORT" -r "$CONNECTION_DIR/retention.paths" 2>"$UTILITY_STDERR" | "$TRUSTED_TAIL" -n +$((KEEP + 1)) 2>>"$UTILITY_STDERR")"; then echo "promotion failed (retention)" >&2; exit 1; fi
PRUNED=0
if [ -n "$OLD_DUMPS" ]; then
  while IFS= read -r old_dump; do
    [ -n "$old_dump" ] || continue
    if ! remove_owned_file "$old_dump" "$DUMP_ROOT" 'minime-pre-promote-'; then echo "promotion failed (retention_cleanup)" >&2; exit 1; fi
    PRUNED=$((PRUNED + 1))
  done <<EOF
$OLD_DUMPS
EOF
fi
echo "==> promoting restored database"
echo "==> promote complete; local scratch has been promoted."
printf 'canonical pre-promote safety net retention complete (pruned %s)\n' "$PRUNED"
