#!/bin/bash
# make restore-pitr TIME="2026-06-12 14:30": point-in-time restore into a SCRATCH db.
# Picks the latest restic snapshot (tags db-snap/dream) at or before TIME, restores its
# pg_dump into minime_restore, and runs the same schema/data validation as restore-drill.
# NEVER writes the live minime DB — promotion is the separate, deliberate promote-restore.sh.
# Unlike restore-drill there is no dump-now fallback: a past TIME is meaningless without restic.
set -euo pipefail
cd "$(dirname "$0")/.."

: "${TIME:?usage: TIME=\"2026-06-12 14:30\" $0   (local wall-clock, snapshot at or before)}"

if [ -z "${RESTIC_REPOSITORY:-}" ] || ! command -v restic >/dev/null 2>&1; then
  echo "restic not configured (RESTIC_REPOSITORY unset or restic binary missing);" >&2
  echo "a point-in-time restore has no meaningful fallback for a past TIME." >&2
  exit 2
fi

PGBIN=""
for c in "$(brew --prefix postgresql@17 2>/dev/null)/bin" /usr/local/bin /usr/bin; do
  [ -x "$c/psql" ] && PGBIN="$c" && break
done
[ -z "$PGBIN" ] && { echo "psql not found" >&2; exit 1; }

RESTORE_DB="minime_restore"
ADMIN_URL="postgres://minime:minime@localhost:5432/postgres"
RESTORE_URL="postgres://minime:minime@localhost:5432/$RESTORE_DB"
LIVE_URL="${DATABASE_URL:-postgres://minime:minime@localhost:5432/minime}"

echo "==> selecting restic snapshot at or before \"$TIME\""
PICK=$(restic snapshots --json | TIME="$TIME" bun run scripts/pick-snapshot.ts)
SNAP_ID=$(printf '%s' "$PICK" | cut -f1)
SNAP_TIME=$(printf '%s' "$PICK" | cut -f2)
echo "==> picked snapshot $SNAP_ID ($SNAP_TIME)"

echo "==> restoring snapshot $SNAP_ID"
RESTORE_DIR=$(mktemp -d)
# the restored dump is tier-0 plaintext — never leave it behind in /tmp (§12)
trap 'rm -rf "$RESTORE_DIR"' EXIT
restic restore "$SNAP_ID" --target "$RESTORE_DIR" --include "**/db-dump/minime.sql"
DUMP=$(find "$RESTORE_DIR" -name minime.sql | head -1)
[ -z "$DUMP" ] && { echo "no db-dump/minime.sql in snapshot $SNAP_ID" >&2; exit 1; }

echo "==> loading into scratch db $RESTORE_DB (live DB untouched)"
"$PGBIN/psql" "$ADMIN_URL" -qAt -c "drop database if exists $RESTORE_DB"
"$PGBIN/psql" "$ADMIN_URL" -qAt -c "create database $RESTORE_DB"
# extensions need a superuser (brew: the OS user; docker: minime is superuser already)
"$PGBIN/psql" -h localhost -p 5432 -d "$RESTORE_DB" -qAt \
  -c "create extension if not exists vector; create extension if not exists pgcrypto;" 2>/dev/null ||
  "$PGBIN/psql" "$RESTORE_URL" -qAt \
    -c "create extension if not exists vector; create extension if not exists pgcrypto;"
# ON_ERROR_STOP=0: a pg_dump replay legitimately emits benign notices (e.g. "extension already
# exists"). But minime_restore is a PROMOTION CANDIDATE, so a torn restore must never pass silently:
# capture stderr, count real ERROR: lines, and fail hard (exit 4) if any slipped through.
REPLAY_ERR=$(mktemp)
"$PGBIN/psql" "$RESTORE_URL" -q -v ON_ERROR_STOP=0 -f "$DUMP" >/dev/null 2>"$REPLAY_ERR" || true
# psql -f prefixes errors as "psql:<file>:<line>: ERROR: …", so anchor on ": ERROR:" not "^ERROR:"
RESTORE_ERRORS=$(grep -c ': ERROR:' "$REPLAY_ERR" || true)
rm -f "$REPLAY_ERR"

echo "==> validating restored database"
"$PGBIN/psql" "$RESTORE_URL" -v ON_ERROR_STOP=1 -qAt <<'SQL'
do $$
declare n int;
begin
  -- spec tables present
  select count(*) into n from pg_tables where schemaname = 'public'
    and tablename in ('pages','journal_entries','decisions','events','chunks','transactions','metric_defs');
  if n < 7 then raise exception 'restore-pitr: missing tables (found %)', n; end if;
  -- data made it across
  select count(*) into n from metric_defs;
  if n < 6 then raise exception 'restore-pitr: metric_defs empty after restore'; end if;
  -- events append-only trigger survived the dump/restore
  begin
    insert into events (actor, verb) values ('pitr', 'pitr:probe');
    update events set verb = 'tampered' where verb = 'pitr:probe';
    raise exception 'restore-pitr: events UPDATE was not blocked';
  exception when others then
    if sqlerrm like '%append-only%' then null; -- trigger fired: good
    else raise;
    end if;
  end;
end $$;
select 'restore-pitr: validation OK';
SQL

# Row-count comparison: live vs restored, for the tables an owner reasons about when deciding
# between a full promote and a cherry-pick. Live DB is read-only here.
rowcount() { "$PGBIN/psql" "$1" -qAt -c "select count(*) from $2" 2>/dev/null || echo "?"; }
echo ""
echo "==> live vs restored row counts (snapshot $SNAP_ID @ $SNAP_TIME)"
printf '    %-16s %12s %12s\n' "table" "live" "restored"
for t in journal_entries events decisions; do
  printf '    %-16s %12s %12s\n' "$t" "$(rowcount "$LIVE_URL" "$t")" "$(rowcount "$RESTORE_URL" "$t")"
done
echo ""
echo "==> dump replay ERROR: lines = $RESTORE_ERRORS"

# A promotion candidate with replay errors is a torn restore — refuse to bless it.
if [ "$RESTORE_ERRORS" -gt 0 ]; then
  echo "" >&2
  echo "restore-pitr: $RESTORE_ERRORS ERROR: line(s) during dump replay into $RESTORE_DB." >&2
  echo "the restore is torn and MUST NOT be promoted. Inspect $RESTORE_DB and re-run." >&2
  exit 4
fi

cat <<EOF

==> scratch DB "$RESTORE_DB" left in place. Live "minime" was not modified.

Next steps:
  - Cherry-pick (the common case — recover specific rows without losing newer data):
      psql "$RESTORE_URL" -c "copy (select * from <table> where <cond>) to stdout" \\
        | psql "$LIVE_URL" -c "copy <table> from stdin"
    (adjust columns/conflict handling per table; inspect $RESTORE_DB first).
  - Full promote (replace live with this snapshot — destroys data newer than $SNAP_TIME):
      make promote-restore
EOF
