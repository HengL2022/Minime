#!/bin/bash
# In-place software update: pull the new version from GitHub WITHOUT touching the
# database or settings. .env* and data/ are gitignored, so git can never modify them;
# the DB is only ever changed by forward-only, idempotent migrations — preceded here by
# a tagged restic snapshot when backups are configured. Safe to re-run; non-interactive
# (same contract as scripts/install.sh — see AGENTS.md). macOS bash-3.2 clean.
#   bash scripts/update.sh [--skip-verify]
# Exit 0 = updated (or already current), 1 backup, 2 bad flag, 30 git, 11 deps, 50 migrate, 70 verify.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

# The whole run lives inside main(): bash parses the function completely before executing,
# so `git pull` rewriting this very file mid-run cannot corrupt the running script.
main() {
  SKIP_VERIFY=0
  for a in "$@"; do
    case "$a" in
      --skip-verify) SKIP_VERIFY=1 ;;
      *) echo "usage: bash scripts/update.sh [--skip-verify]" >&2; return 2 ;;
    esac
  done
  export PATH="$HOME/.bun/bin:$PATH"
  TOTAL=7
  SNAP="not configured" VERIFY="skipped" MIGRATIONS="none"

  line() { printf '[%d/%d] %-5s %s: %s\n' "$1" "$TOTAL" "$2" "$3" "$4"; }
  die() { # exit-code step n name error fix
    line "$2" FAIL "$3" "$4"
    echo "ERROR: $4"
    echo "FIX: $5"
    return "$1"
  }

  # ---- 1. clean preflight -------------------------------------------------------
  OLD="$(git rev-parse --short HEAD 2>/dev/null)" ||
    { die 30 1 git "not a git checkout" "reinstall via git clone (README)"; return $?; }
  if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
    die 30 1 git "tracked files have local modifications" \
      "git stash (or commit), re-run scripts/update.sh, then git stash pop"
    return $?
  fi

  line 1 OK preflight "clean tracked tree at $OLD"

  # ---- 2. pre-migrate safety snapshot --------------------------------------------
  if bun run src/cli.ts backup:pre-update; then
    SNAP="taken"
    SNAPSHOT_OUTCOME="taken"
    line 2 OK snap "pre-update db snapshot (restic tag db-snap)"
  else
    BACKUP_STATUS=$?
    if [ "$BACKUP_STATUS" -eq 3 ]; then
      SNAP="unconfigured"
      SNAPSHOT_OUTCOME="unconfigured"
      line 2 SKIP snap "no snapshot — backups are unconfigured"
    else
      die 1 2 snap "pre-update db snapshot failed" \
        "fix RESTIC_REPOSITORY and RESTIC_PASSWORD_FILE, then re-run"
      return $?
    fi
  fi

  # ---- 3. git: fast-forward to origin -----------------------------------------
  git fetch origin --quiet ||
    { die 30 3 git "git fetch failed (network? auth?)" "git fetch origin (full output), then re-run"; return $?; }
  if ! git pull --ff-only --quiet 2>/dev/null; then
    die 30 3 git "branch has diverged from origin (no fast-forward)" \
      "git status; either git pull --rebase or reset to origin, then re-run"
    return $?
  fi
  NEW="$(git rev-parse --short HEAD)"
  if [ "$OLD" = "$NEW" ]; then
    line 3 OK git "already at $NEW (no upstream changes)"
  else
    line 3 OK git "$OLD -> $NEW ($(git rev-list --count "$OLD..$NEW") commit(s))"
  fi

  # ---- 4. deps ------------------------------------------------------------------
  if bun install --frozen-lockfile >/dev/null 2>&1; then
    line 4 OK deps "node_modules in sync with lockfile"
  else
    die 11 4 deps "bun install failed" "bun install (full output), then re-run"
    return $?
  fi

  # ---- 5. migrate (forward-only, idempotent, transactional per file) -------------
  out="$(bun run src/cli.ts migrate --context update --snapshot-outcome "$SNAPSHOT_OUTCOME" 2>&1)" ||
    { die 50 5 migrate "$(echo "$out" | tail -1)" \
        "bun run src/cli.ts migrate (full output); rollback = git checkout $OLD + make restore-pitr"; return $?; }
  MIGRATIONS="$(echo "$out" | tail -1)"
  line 5 OK migrate "$MIGRATIONS"

  # ---- 6. verify (offline suite; never touches the live DB's data) ----------------
  if [ "$SKIP_VERIFY" = 1 ]; then
    line 6 SKIP verify "--skip-verify given"
  elif out="$(bun test 2>&1)"; then
    VERIFY="pass"
    line 6 OK verify "offline test suite green"
  else
    printf '%s\n' "$out" | tail -20
    die 70 6 verify "test suite failed on the new version" \
      "bun test (full output); rollback = git checkout $OLD (db unchanged unless migrations above ran)"
    return $?
  fi

  # ---- 7. restart reminder --------------------------------------------------------
  if pgrep -f "src/cli.ts serve" >/dev/null 2>&1; then
    line 7 WARN serve "resident server is still running the OLD code — restart it"
  else
    line 7 OK serve "not running; next start picks up $NEW"
  fi

  echo "==== MINIME UPDATE SUMMARY ===="
  echo "status: ok"
  echo "version: $OLD -> $NEW"
  echo "snapshot: $SNAP"
  echo "migrations: $MIGRATIONS"
  echo "verify: $VERIFY"
  echo "untouched: .env*, data/, backups (gitignored — never written by update)"
  echo "next: restart 'bun run src/cli.ts serve' if it was running"
  echo "==============================="
  return 0
}

main "$@"
