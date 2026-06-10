#!/bin/bash
# make restore-drill: prove backups restore. Restores the latest restic snapshot's pg_dump
# into a scratch database and validates the schema + data shape against M1 expectations.
# Without restic configured, falls back to dump-now → restore (still proves the restore path).
set -euo pipefail
cd "$(dirname "$0")/.."

PGBIN=""
for c in "$(brew --prefix postgresql@17 2>/dev/null)/bin" /usr/local/bin /usr/bin; do
  [ -x "$c/psql" ] && PGBIN="$c" && break
done
[ -z "$PGBIN" ] && { echo "psql not found" >&2; exit 1; }

DRILL_DB="minime_drill"
ADMIN_URL="postgres://minime:minime@localhost:5432/postgres"
DRILL_URL="postgres://minime:minime@localhost:5432/$DRILL_DB"
SRC_URL="${DATABASE_URL:-postgres://minime:minime@localhost:5432/minime}"
DUMP=/tmp/minime-drill-dump.sql

if [ -n "${RESTIC_REPOSITORY:-}" ] && command -v restic >/dev/null 2>&1; then
  echo "==> restoring latest restic snapshot"
  RESTORE_DIR=$(mktemp -d)
  restic restore latest --target "$RESTORE_DIR" --include "**/db-dump/minime.sql"
  DUMP=$(find "$RESTORE_DIR" -name minime.sql | head -1)
  [ -z "$DUMP" ] && { echo "no minime.sql in latest snapshot" >&2; exit 1; }
else
  echo "==> restic not configured; drilling with a fresh pg_dump of $SRC_URL"
  "$PGBIN/pg_dump" "$SRC_URL" > "$DUMP"
fi

echo "==> restoring into scratch db $DRILL_DB"
"$PGBIN/psql" "$ADMIN_URL" -qAt -c "drop database if exists $DRILL_DB"
"$PGBIN/psql" "$ADMIN_URL" -qAt -c "create database $DRILL_DB"
# extensions need a superuser (brew: the OS user; docker: minime is superuser already)
"$PGBIN/psql" -h localhost -p 5432 -d "$DRILL_DB" -qAt \
  -c "create extension if not exists vector; create extension if not exists pgcrypto;" 2>/dev/null ||
  "$PGBIN/psql" "$DRILL_URL" -qAt \
    -c "create extension if not exists vector; create extension if not exists pgcrypto;"
"$PGBIN/psql" "$DRILL_URL" -q -v ON_ERROR_STOP=0 -f "$DUMP" >/dev/null 2>&1 || true

echo "==> validating restored database"
"$PGBIN/psql" "$DRILL_URL" -v ON_ERROR_STOP=1 -qAt <<'SQL'
do $$
declare n int;
begin
  -- spec tables present
  select count(*) into n from pg_tables where schemaname = 'public'
    and tablename in ('pages','journal_entries','decisions','events','chunks','transactions','metric_defs');
  if n < 7 then raise exception 'restore drill: missing tables (found %)', n; end if;
  -- data made it across
  select count(*) into n from metric_defs;
  if n < 6 then raise exception 'restore drill: metric_defs empty after restore'; end if;
  -- events append-only trigger survived the dump/restore
  begin
    insert into events (actor, verb) values ('drill', 'drill:probe');
    update events set verb = 'tampered' where verb = 'drill:probe';
    raise exception 'restore drill: events UPDATE was not blocked';
  exception when others then
    if sqlerrm like '%append-only%' then null; -- trigger fired: good
    else raise;
    end if;
  end;
end $$;
select 'restore drill: OK';
SQL
"$PGBIN/psql" "$ADMIN_URL" -qAt -c "drop database if exists $DRILL_DB"
echo "==> restore drill green"
