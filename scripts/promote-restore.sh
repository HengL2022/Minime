#!/bin/bash
# make promote-restore: swap the scratch minime_restore in as the live minime DB.
# Deliberately separate from restore-pitr.sh — this is the only script in the backup suite
# that mutates the live database, and only by an atomic rename (no in-place writes).
# Refuses to run while anything else is connected to minime, and dumps a pre-promote safety
# snapshot first. The common case is a PARTIAL rollback (cherry-pick), not a full promote.
set -euo pipefail
cd "$(dirname "$0")/.."

PGBIN=""
for c in "$(brew --prefix postgresql@17 2>/dev/null)/bin" /usr/local/bin /usr/bin; do
  [ -x "$c/psql" ] && PGBIN="$c" && break
done
[ -z "$PGBIN" ] && { echo "psql not found" >&2; exit 1; }

ADMIN_URL="postgres://minime:minime@localhost:5432/postgres"
LIVE_URL="${DATABASE_URL:-postgres://minime:minime@localhost:5432/minime}"
TS=$(date +%Y%m%d-%H%M%S)
REPLACED_DB="minime_replaced_$TS"

# Scratch DB must exist (restore-pitr.sh produces minime_restore; restore-drill.sh produces
# the throwaway minime_drill, which is NOT a promotion candidate).
EXISTS=$("$PGBIN/psql" "$ADMIN_URL" -qAt \
  -c "select 1 from pg_database where datname = 'minime_restore'")
[ "$EXISTS" = "1" ] || { echo "minime_restore does not exist; run restore-pitr first" >&2; exit 1; }

# Refuse if anything is using the live DB. Exclude this checking connection (pg_backend_pid()).
echo "==> checking for live connections on minime"
ACTIVE=$("$PGBIN/psql" "$ADMIN_URL" -qAt -c \
  "select count(*) from pg_stat_activity where datname = 'minime' and pid <> pg_backend_pid()")
if [ "$ACTIVE" != "0" ]; then
  echo "refusing to promote: $ACTIVE live connection(s) on minime." >&2
  echo "stop the Minime server (and any psql sessions) on minime, then retry." >&2
  exit 1
fi

# Safety net: dump the current live DB before we move it aside, and (if restic is configured)
# push that dump as a one-off tagged snapshot so the pre-promote state is recoverable remotely.
DUMP="db-dump/minime-pre-promote-$TS.sql"
mkdir -p db-dump
echo "==> dumping live minime → $DUMP (pre-promote safety net)"
"$PGBIN/pg_dump" "$LIVE_URL" > "$DUMP"
if [ -n "${RESTIC_REPOSITORY:-}" ] && command -v restic >/dev/null 2>&1; then
  echo "==> restic backup --tag pre-promote $DUMP"
  restic backup --tag pre-promote "$DUMP" || echo "warning: pre-promote restic backup failed" >&2
else
  echo "==> restic not configured; pre-promote safety dump is local-only ($DUMP)"
fi

echo "==> promoting: minime → $REPLACED_DB, minime_restore → minime"
"$PGBIN/psql" "$ADMIN_URL" -v ON_ERROR_STOP=1 -qAt \
  -c "alter database minime rename to $REPLACED_DB" \
  -c "alter database minime_restore rename to minime"

# Retention: pre-promote artifacts are emergency safety nets, not archives. They fall outside
# every other retention policy and would accumulate unboundedly — and the .sql is tier-0 plaintext
# on disk. Keep only the 5 most recent of each (restic snapshots + local dumps), now that the
# promote succeeded and this run's net is durable.
KEEP=5
if [ -n "${RESTIC_REPOSITORY:-}" ] && command -v restic >/dev/null 2>&1; then
  echo "==> pruning pre-promote restic snapshots (keep last $KEEP)"
  restic forget --tag pre-promote --group-by host,tags --keep-last "$KEEP" --prune \
    || echo "warning: pre-promote restic forget/prune failed" >&2
fi
# Delete pre-promote .sql dumps older than the 5 most recent (this run's dump is among them).
# Portable for macOS bash 3.2: no mapfile, no array-under-set-u; dump names ($TS) have no whitespace.
OLD_DUMPS=$(ls -1t db-dump/minime-pre-promote-*.sql 2>/dev/null | tail -n +$((KEEP + 1)) || true)
PRUNED=0
if [ -n "$OLD_DUMPS" ]; then
  PRUNED=$(printf '%s\n' "$OLD_DUMPS" | wc -l | tr -d ' ')
  printf '%s\n' "$OLD_DUMPS" | while IFS= read -r f; do rm -f "$f"; done
fi
[ "$PRUNED" -gt 0 ] && echo "==> deleted $PRUNED old pre-promote .sql dump(s) (kept newest $KEEP)"

cat <<EOF

==> promote complete. Live minime is now the restored snapshot.
    Previous live DB preserved as: $REPLACED_DB
    Pre-promote dump:              $DUMP
    Pre-promote retention:         newest $KEEP kept in db-dump/ (and --tag pre-promote restic if configured); older pruned

Undo (rename back — do this BEFORE anything reconnects and writes):
  psql "$ADMIN_URL" \\
    -c "alter database minime rename to minime_restore" \\
    -c "alter database $REPLACED_DB rename to minime"

Note: a full promote is the rare case. For the common partial rollback, do NOT promote —
cherry-pick the affected rows from minime_restore into live minime (see restore-pitr output).
EOF
