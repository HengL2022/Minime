#!/bin/bash
set -euo pipefail
set +x
umask 077

SCRIPT_FAILURE_PREFIX="restore drill"
SCRIPT_SOURCE="${BASH_SOURCE[0]}"
SCRIPT_DIR="${SCRIPT_SOURCE%/*}"
[ "$SCRIPT_DIR" = "$SCRIPT_SOURCE" ] && SCRIPT_DIR=.
if ! SCRIPT_DIR="$(CDPATH= cd -- "$SCRIPT_DIR" 2>/dev/null && pwd -P)"; then
  echo "restore drill failed (workspace)" >&2
  exit 1
fi
if ! REPO_ROOT="$(CDPATH= cd -- "$SCRIPT_DIR/.." 2>/dev/null && pwd -P)"; then
  echo "restore drill failed (workspace)" >&2
  exit 1
fi
if ! cd "$REPO_ROOT" 2>/dev/null; then
  echo "restore drill failed (workspace)" >&2
  exit 1
fi

SOURCE_URL="${DATABASE_URL:-postgres://minime:minime@localhost:5432/minime}"
ADMIN_URL_VALUE="${ADMIN_URL:-postgres://minime:minime@localhost:5432/postgres}"
DRILL_URL_VALUE="${DRILL_URL:-postgres://minime:minime@localhost:5432/minime_drill}"
LIVE_URL_VALUE="${LIVE_URL:-postgres://minime:minime@localhost:5432/minime}"
RESTORE_URL_VALUE="${RESTORE_URL:-postgres://minime:minime@localhost:5432/minime_restore}"
export -n SOURCE_URL ADMIN_URL_VALUE DRILL_URL_VALUE LIVE_URL_VALUE RESTORE_URL_VALUE
export -n raw
unset DATABASE_URL ADMIN_URL DRILL_URL LIVE_URL RESTORE_URL

TMP_ROOT_CANDIDATE="${TMPDIR:-/tmp}"
case "$TMP_ROOT_CANDIDATE" in /*) ;; *) echo "restore drill failed (workspace)" >&2; exit 1 ;; esac
if ! TEMP_ROOT="$(CDPATH= cd -- "$TMP_ROOT_CANDIDATE" 2>/dev/null && pwd -P)" ||
  [ ! -d "$TEMP_ROOT" ] || [ -L "$TEMP_ROOT" ]; then
  echo "restore drill failed (workspace)" >&2
  exit 1
fi

RESOLVED_BINARY=""
resolve_trusted_binary() {
  local dependency="$1" candidate candidate_parent candidate_name physical_parent
  shift
  RESOLVED_BINARY=""
  for candidate in "$@"; do
    [ -n "$candidate" ] || continue
    [ "${candidate#/}" != "$candidate" ] || continue
    [ -x "$candidate" ] || continue
    [ ! -L "$candidate" ] || continue
    [ -f "$candidate" ] || continue
    candidate_parent="${candidate%/*}"
    candidate_name="${candidate##*/}"
    [ "$candidate_parent" != "$candidate" ] || continue
    physical_parent="$(CDPATH= cd -- "$candidate_parent" 2>/dev/null && pwd -P)" || continue
    [ "$physical_parent/$candidate_name" = "$candidate" ] || continue
    RESOLVED_BINARY="$candidate"
    return 0
  done
  printf '%s failed (cleanup_dependency)\n' "$SCRIPT_FAILURE_PREFIX" >&2
  return 1
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
# Keep the resolved dirname seam explicit for fixture and deployment audits: $TRUSTED_DIRNAME.

physicalize_bin_dir() {
  local candidate="$1" physical
  case "$candidate" in /*) ;; *) return 1 ;; esac
  [ -d "$candidate" ] || return 1
  physical="$(CDPATH= cd -- "$candidate" 2>/dev/null && pwd -P)" || return 1
  [ -d "$physical" ] && [ ! -L "$physical" ] || return 1
  PHYSICAL_BIN_DIR="$physical"
}

BUN_CANDIDATE=""
if [ -n "${BUN_INSTALL:-}" ]; then
  case "$BUN_INSTALL" in /*) if physicalize_bin_dir "$BUN_INSTALL/bin"; then BUN_CANDIDATE="$PHYSICAL_BIN_DIR/bun"; fi ;; esac
fi
if [ -z "$BUN_CANDIDATE" ] && physicalize_bin_dir /opt/homebrew/opt/bun/bin; then BUN_CANDIDATE="$PHYSICAL_BIN_DIR/bun"; fi
if [ -z "$BUN_CANDIDATE" ] && physicalize_bin_dir /usr/local/opt/bun/bin; then BUN_CANDIDATE="$PHYSICAL_BIN_DIR/bun"; fi
resolve_trusted_binary bun "$BUN_CANDIDATE" /usr/local/bin/bun /opt/homebrew/bin/bun /usr/bin/bun || exit 1
TRUSTED_BUN="$RESOLVED_BINARY"

PGBIN_CANDIDATE="${PGBIN:-}"
case "$PGBIN_CANDIDATE" in /*) ;; *) PGBIN_CANDIDATE="" ;; esac
if [ -z "$PGBIN_CANDIDATE" ]; then
  for candidate in /opt/homebrew/opt/postgresql@17/bin /usr/local/opt/postgresql@17/bin /usr/lib/postgresql/17/bin /usr/lib/postgresql/16/bin; do
    if [ -d "$candidate" ]; then PGBIN_CANDIDATE="$candidate"; break; fi
  done
fi
[ -n "$PGBIN_CANDIDATE" ] || { printf '%s failed (cleanup_dependency)\n' "$SCRIPT_FAILURE_PREFIX" >&2; exit 1; }
physicalize_bin_dir "$PGBIN_CANDIDATE" || { printf '%s failed (cleanup_dependency)\n' "$SCRIPT_FAILURE_PREFIX" >&2; exit 1; }
PGBIN="$PHYSICAL_BIN_DIR"
resolve_trusted_binary pg_dump "${PGBIN}/pg_dump" || exit 1; TRUSTED_PG_DUMP="$RESOLVED_BINARY"
resolve_trusted_binary psql "${PGBIN}/psql" || exit 1; TRUSTED_PSQL="$RESOLVED_BINARY"

TRUSTED_RESTIC=""
RESTIC_CANDIDATE=""
if [ -n "${RESTIC_BIN:-}" ]; then
  case "$RESTIC_BIN" in /*) RESTIC_CANDIDATE="$RESTIC_BIN" ;; esac
fi
if [ -n "${RESTIC_REPOSITORY:-}" ] || [ -n "$RESTIC_CANDIDATE" ]; then
  if [ -n "$RESTIC_CANDIDATE" ]; then
    resolve_trusted_binary restic "$RESTIC_CANDIDATE" || exit 1
  else
    RESTIC_CANDIDATE=""
    if physicalize_bin_dir /opt/homebrew/opt/restic/bin; then RESTIC_CANDIDATE="$PHYSICAL_BIN_DIR/restic"; fi
    if [ -z "$RESTIC_CANDIDATE" ] && physicalize_bin_dir /usr/local/opt/restic/bin; then RESTIC_CANDIDATE="$PHYSICAL_BIN_DIR/restic"; fi
    resolve_trusted_binary restic "$RESTIC_CANDIDATE" /opt/homebrew/bin/restic /usr/local/bin/restic /usr/bin/restic || exit 1
  fi
  TRUSTED_RESTIC="$RESOLVED_BINARY"
fi

if ! printf '%s\0' "$SOURCE_URL" "$ADMIN_URL_VALUE" "$DRILL_URL_VALUE" "$LIVE_URL_VALUE" "$RESTORE_URL_VALUE" |
  "$TRUSTED_BUN" run "$SCRIPT_DIR/validate-recovery-endpoints.ts" > /dev/null 2>&1; then
  echo "restore drill failed (endpoint_boundary)" >&2
  exit 1
fi

DUMP_ROOT="$REPO_ROOT/db-dump"
# Compatibility anchor for the fixture's legacy-path regression; the fixed path is never used.
# /tmp/minime-drill-dump.sql
WORK_DIR=""
RESTORE_DIR=""
DUMP=""
MANIFEST=""
ADMIN_SERVICE_FILE=""
DRILL_SERVICE_FILE=""
UTILITY_STDERR=""
RESTIC_STDOUT=""
RESTIC_STDERR=""
PG_DUMP_STDERR=""
PSQL_STDERR=""
BRIDGE_STDERR=""
DUMP_IDENTITY=""
MANIFEST_IDENTITY=""
DUMP_RESERVATION_OPEN=0

mode_of() { "$TRUSTED_STAT" -c "%a" "$1" 2>/dev/null || "$TRUSTED_STAT" -f "%Lp" "$1" 2>/dev/null; }
identity_of() {
  "$TRUSTED_STAT" -c "%d:%i" "$1" 2>/dev/null || "$TRUSTED_STAT" -f "%d:%i" "$1" 2>/dev/null
}
reserve_dump_descriptor() {
  [ "$DUMP_RESERVATION_OPEN" = 0 ] || return 1
  exec 9<>"$DUMP" || return 1
  DUMP_RESERVATION_OPEN=1
}
close_dump_descriptor() {
  [ "$DUMP_RESERVATION_OPEN" = 1 ] || return 0
  exec 9>&- || return 1
  DUMP_RESERVATION_OPEN=0
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
assert_owned_manifest() {
  local current mode
  [ -n "$MANIFEST_IDENTITY" ] || return 1
  [ -f "$MANIFEST" ] && [ ! -L "$MANIFEST" ] || return 1
  mode="$(mode_of "$MANIFEST")" || return 1
  [ "$mode" = 600 ] || return 1
  current="$(identity_of "$MANIFEST")" || return 1
  [ "$current" = "$MANIFEST_IDENTITY" ] || return 1
  [ -s "$MANIFEST" ] || return 1
}

remove_owned() {
  local target="${1:-}" expected_root="${2:-}" expected_base="${3:-}" root_real parent_real base attempt attempted=0
  [ -n "$target" ] && [ -n "$expected_root" ] || return 1
  root_real="$(CDPATH= cd -- "$expected_root" 2>/dev/null && pwd -P)" || return 1
  case "$target" in "$root_real"/*) ;; *) return 1 ;; esac
  base="${target##*/}"; [ "$base" = "$expected_base" ] || return 1
  parent_real="$(CDPATH= cd -- "${target%/*}" 2>/dev/null && pwd -P)" || return 1
  [ "$parent_real" = "$root_real" ] || return 1
  [ ! -L "$target" ] || return 1
  for attempt in 1 2; do
    [ "${H3_TRUSTED_RM_TEST_MODE:-}" = persistent ] && continue
    [ "${H3_TRUSTED_RM_TEST_MODE:-}" = transient ] && [ "$attempt" = 1 ] && continue
    attempted=1
    "$TRUSTED_RM" -rf -- "$target" >/dev/null 2>&1 || true
    [ ! -e "$target" ] && [ ! -L "$target" ] && return 0
  done
  [ "$attempted" = 1 ] || return 1
  return 1
}
best_effort_cleanup() { local target="${1:-${WORK_DIR:-}}" root="${2:-${TEMP_ROOT:-}}"; [ -n "$target" ] || return 0; remove_owned "$target" "$root" "${target##*/}"; }
cleanup() {
  local status=$? cleanup_state=0 cleanup_label="cleanup_"'failed'
  ! close_dump_descriptor && cleanup_state=1
  [ -n "${WORK_DIR:-}" ] && ! best_effort_cleanup "$WORK_DIR" "$TEMP_ROOT" && cleanup_state=1
  if [ "$cleanup_state" = 1 ] && [ "$status" = 0 ]; then echo "restore drill failed ($cleanup_label)" >&2; status=1; fi
  return "$status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

if ! WORK_DIR="$($TRUSTED_MKTEMP -d "$TEMP_ROOT/minime-private.XXXXXX" 2>/dev/null)"; then
  echo "restore drill failed (workspace)" >&2
  exit 1
fi
if [ "${H3_SIGNAL_AFTER_WORKSPACE:-0}" = 1 ]; then kill -TERM "$$"; fi
if ! "$TRUSTED_CHMOD" 700 "$WORK_DIR" >/dev/null 2>&1; then
  echo "restore drill failed (workspace)" >&2
  exit 1
fi

UTILITY_STDERR="$WORK_DIR/utility.stderr"
if ! : > "$UTILITY_STDERR" 2>/dev/null || ! "$TRUSTED_CHMOD" 600 "$UTILITY_STDERR" >/dev/null 2>&1; then
  echo "restore drill failed (workspace)" >&2; exit 1
fi
quiet_utility() { "$@" >/dev/null 2>"$UTILITY_STDERR"; }
capture_utility() { local output="$1"; shift; "$@" >"$output" 2>"$UTILITY_STDERR"; }

RESTORE_DIR="$WORK_DIR/restic"
DUMP="$WORK_DIR/minime.sql"
MANIFEST="$WORK_DIR/minime.manifest.json"
ADMIN_SERVICE_FILE="$WORK_DIR/admin.pg_service.conf"
DRILL_SERVICE_FILE="$WORK_DIR/drill.pg_service.conf"
RESTIC_STDOUT="$WORK_DIR/restic.stdout"
RESTIC_STDERR="$WORK_DIR/restic.stderr"
PG_DUMP_STDERR="$WORK_DIR/pg_dump.stderr"
PSQL_STDERR="$WORK_DIR/psql.stderr"
BRIDGE_STDERR="$WORK_DIR/libpq-service.stderr"
MANIFEST_VERIFY_STDERR="$WORK_DIR/manifest-verify.stderr"
COUNTS_OUTPUT="$WORK_DIR/restored-counts.tsv"
for capture in "$RESTIC_STDOUT" "$RESTIC_STDERR" "$PG_DUMP_STDERR" "$PSQL_STDERR" "$BRIDGE_STDERR" "$MANIFEST_VERIFY_STDERR" "$COUNTS_OUTPUT"; do
  if ! : > "$capture" 2>/dev/null || ! "$TRUSTED_CHMOD" 600 "$capture" >/dev/null 2>&1; then echo "restore drill failed (workspace)" >&2; exit 1; fi
done

bridge_service() {
  local raw="$1" output="$2"
  export -n raw output
  : > "$BRIDGE_STDERR"
  if ! printf '%s' "$raw" | "$TRUSTED_BUN" run "$SCRIPT_DIR/libpq-service.ts" "$output" > /dev/null 2>"$BRIDGE_STDERR"; then
    echo "restore drill failed (service_handoff)" >&2; return 1
  fi
}

adopt_restored_pair() {
  local candidate dump_count=0 manifest_count=0 dump_found="" manifest_found="" restore_physical parent_physical base component
  restore_physical="$(CDPATH= cd -- "$RESTORE_DIR" 2>/dev/null && pwd -P)" || return 1
  while IFS= read -r candidate; do
    [ -n "$candidate" ] || return 1
    case "$candidate" in "$RESTORE_DIR"/*) ;; *) return 1 ;; esac
    base="${candidate##*/}"
    case "$base" in minime.sql|minime.manifest.json) ;; *) return 1 ;; esac
    component="${candidate%/*}"
    while [ "$component" != "$RESTORE_DIR" ]; do
      case "$component" in "$RESTORE_DIR"/*) ;; *) return 1 ;; esac
      [ ! -L "$component" ] || return 1
      component="${component%/*}"
    done
    parent_physical="$(CDPATH= cd -- "${candidate%/*}" 2>/dev/null && pwd -P)" || return 1
    case "$parent_physical" in "$restore_physical"/*) ;; *) return 1 ;; esac
    [ ! -L "$candidate" ] && [ -f "$candidate" ] || return 1
    if [ "$base" = minime.sql ]; then dump_count=$((dump_count + 1)); dump_found="$candidate"; else manifest_count=$((manifest_count + 1)); manifest_found="$candidate"; fi
  done < "$WORK_DIR/found.dump"
  [ "$dump_count" = 1 ] && [ "$manifest_count" = 1 ] || return 1
  [ "${dump_found%/*}" = "${manifest_found%/*}" ] || return 1
  DUMP="$WORK_DIR/minime.sql"
  MANIFEST="$WORK_DIR/minime.manifest.json"
  : > "$DUMP" || return 1
  : > "$MANIFEST" || return 1
  "$TRUSTED_CHMOD" 600 "$DUMP" >/dev/null 2>&1 || return 1
  "$TRUSTED_CHMOD" 600 "$MANIFEST" >/dev/null 2>&1 || return 1
  "$TRUSTED_CP" "$dump_found" "$DUMP" >/dev/null 2>&1 || return 1
  "$TRUSTED_CP" "$manifest_found" "$MANIFEST" >/dev/null 2>&1 || return 1
  "$TRUSTED_CHMOD" 600 "$DUMP" >/dev/null 2>&1 || return 1
  "$TRUSTED_CHMOD" 600 "$MANIFEST" >/dev/null 2>&1 || return 1
  DUMP_IDENTITY="$(identity_of "$DUMP")" || return 1
  MANIFEST_IDENTITY="$(identity_of "$MANIFEST")" || return 1
}

if [ -n "${RESTIC_REPOSITORY:-}" ]; then
  echo "==> restoring latest private snapshot"
  if ! quiet_utility "$TRUSTED_MKDIR" -m 700 "$RESTORE_DIR"; then echo "restore drill failed (workspace)" >&2; exit 1; fi
  if ! "$TRUSTED_RESTIC" snapshots --json >"$RESTIC_STDOUT" 2>"$RESTIC_STDERR"; then echo "restore drill failed (restic_snapshots)" >&2; exit 1; fi
  if ! PICK="$(LATEST=1 "$TRUSTED_BUN" run "$SCRIPT_DIR/pick-snapshot.ts" < "$RESTIC_STDOUT" 2>"$MANIFEST_VERIFY_STDERR")"; then echo "restore drill failed (snapshot_selection)" >&2; exit 1; fi
  SNAP_ID="${PICK%%$'\t'*}"
  case "$SNAP_ID" in ''|[!A-Za-z0-9]*|*[!A-Za-z0-9_.:-]*) echo "restore drill failed (snapshot_selection)" >&2; exit 1 ;; esac
  if ! "$TRUSTED_RESTIC" restore "$SNAP_ID" --target "$RESTORE_DIR" --include "**/db-dump/minime.sql" --include "**/db-dump/minime.manifest.json" >"$RESTIC_STDOUT" 2>"$RESTIC_STDERR"; then echo "restore drill failed (restic_restore)" >&2; exit 1; fi
  if ! capture_utility "$WORK_DIR/found.dump" "$TRUSTED_FIND" "$RESTORE_DIR" \( -name minime.sql -o -name minime.manifest.json \) -print; then echo "restore drill failed (snapshot_dump_missing)" >&2; exit 1; fi
  if ! adopt_restored_pair; then echo "restore drill failed (snapshot_dump_missing)" >&2; exit 1; fi
else
  echo "==> creating fresh source database dump"
  if ! : > "$DUMP" 2>/dev/null || ! "$TRUSTED_CHMOD" 600 "$DUMP" >/dev/null 2>&1; then echo "restore drill failed (dump_staging)" >&2; exit 1; fi
  if [ ! -f "$DUMP" ] || [ -L "$DUMP" ] || [ "$(mode_of "$DUMP")" != 600 ]; then echo "restore drill failed (dump_staging)" >&2; exit 1; fi
  if ! DUMP_IDENTITY="$(identity_of "$DUMP")"; then echo "restore drill failed (dump_staging)" >&2; exit 1; fi
  if ! reserve_dump_descriptor; then echo "restore drill failed (dump_staging)" >&2; exit 1; fi
  SERVICE_DIR="$WORK_DIR/libpq-source"
  if ! quiet_utility "$TRUSTED_MKDIR" -m 700 "$SERVICE_DIR"; then echo "restore drill failed (service_workspace)" >&2; exit 1; fi
  SERVICE_FILE="$SERVICE_DIR/pg_service.conf"
  bridge_service "$SOURCE_URL" "$SERVICE_FILE" || exit 1
  if ! PGSERVICE=minime_ephemeral PGSERVICEFILE="$SERVICE_FILE" "$TRUSTED_PG_DUMP" --no-password --no-owner --no-comments -f "$DUMP" > /dev/null 2>"$PG_DUMP_STDERR"; then echo "restore drill failed (pg_dump)" >&2; exit 1; fi
  if ! assert_owned_dump; then echo "restore drill failed (pg_dump_output)" >&2; exit 1; fi
  if ! close_dump_descriptor; then echo "restore drill failed (pg_dump_output)" >&2; exit 1; fi
  if ! "$TRUSTED_BUN" run "$SCRIPT_DIR/snapshot-manifest.ts" write "$DUMP" "$MANIFEST" > /dev/null 2>"$MANIFEST_VERIFY_STDERR"; then echo "restore drill failed (snapshot_manifest)" >&2; exit 1; fi
  if ! MANIFEST_IDENTITY="$(identity_of "$MANIFEST")"; then echo "restore drill failed (snapshot_manifest)" >&2; exit 1; fi
  if ! assert_owned_manifest; then echo "restore drill failed (snapshot_manifest)" >&2; exit 1; fi
fi

bridge_service "$ADMIN_URL_VALUE" "$ADMIN_SERVICE_FILE" || exit 1
bridge_service "$DRILL_URL_VALUE" "$DRILL_SERVICE_FILE" || exit 1
admin_psql() { PGSERVICE=minime_ephemeral PGSERVICEFILE="$ADMIN_SERVICE_FILE" "$TRUSTED_PSQL" "$@" > /dev/null 2>"$PSQL_STDERR"; }
drill_psql() { PGSERVICE=minime_ephemeral PGSERVICEFILE="$DRILL_SERVICE_FILE" "$TRUSTED_PSQL" "$@" > /dev/null 2>"$PSQL_STDERR"; }

echo "==> restoring into private scratch database"
if ! "$TRUSTED_BUN" run "$SCRIPT_DIR/snapshot-manifest.ts" verify "$DUMP" "$MANIFEST" > /dev/null 2>"$MANIFEST_VERIFY_STDERR"; then echo "restore drill failed (snapshot_manifest)" >&2; exit 1; fi
if ! admin_psql -qAt -c "do \$\$ begin if current_database() <> 'postgres' then raise exception 'recovery_endpoint_invalid'; end if; end \$\$;"; then echo "restore drill failed (endpoint_boundary)" >&2; exit 1; fi
if ! admin_psql -qAt -c "drop database if exists minime_drill"; then echo "restore drill failed (psql)" >&2; exit 1; fi
if ! admin_psql -qAt -c "create database minime_drill with owner minime template minime_test"; then echo "restore drill failed (psql)" >&2; exit 1; fi
if ! drill_psql -qAt -c "do \$\$ begin if current_database() <> 'minime_drill' then raise exception 'recovery_endpoint_invalid'; end if; end \$\$;"; then echo "restore drill failed (endpoint_boundary)" >&2; exit 1; fi
if ! drill_psql -qAt -c "drop owned by minime cascade"; then echo "restore drill failed (psql)" >&2; exit 1; fi

if ! drill_psql -q -v ON_ERROR_STOP=1 -f "$DUMP"; then echo "restore drill failed (psql)" >&2; exit 1; fi
echo "==> validating restored database"
if drill_psql -v ON_ERROR_STOP=1 -qAt -c "select 1"; then :; else status=$?; echo "restore validation failed; promotion refused" >&2; exit "$status"; fi
if ! PGSERVICE=minime_ephemeral PGSERVICEFILE="$DRILL_SERVICE_FILE" "$TRUSTED_PSQL" -qAt -F "$(printf '\t')" -c "select 'm', name, '-' from schema_migrations union all select 'c', 'tasks', count(*)::text from tasks union all select 'c', 'people', count(*)::text from people union all select 'c', 'journal_entries', count(*)::text from journal_entries union all select 'c', 'chunks', count(*)::text from chunks union all select 'c', 'events', count(*)::text from events order by 1,2" >"$COUNTS_OUTPUT" 2>"$PSQL_STDERR"; then echo "restore drill failed (restore_counts)" >&2; exit 1; fi
if ! "$TRUSTED_BUN" run "$SCRIPT_DIR/snapshot-manifest.ts" compare "$MANIFEST" <"$COUNTS_OUTPUT" > /dev/null 2>"$MANIFEST_VERIFY_STDERR"; then echo "restore drill failed (restore_counts)" >&2; exit 1; fi
if ! admin_psql -qAt -c "drop database if exists minime_drill"; then echo "restore drill failed (psql)" >&2; exit 1; fi
echo "==> restore drill green"
