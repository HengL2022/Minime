#!/bin/bash
# Render and (un)install the resident `serve` process as a per-user background service --
# a launchd LaunchAgent on macOS, or a systemd --user unit on Linux (docs/GUIDE.md "Keeping
# Minime running"). It is just another `serve`: the W3-5 maintenance lock already makes
# whichever process is running the maintenance owner, so this adds no new mode/flag.
# Idempotent in both directions -- stop/bootout first, then (re)install; uninstall is safe
# to re-run even if nothing is installed.
#   bash scripts/install-service.sh install                        # render, write, (re)start
#   DRY_RUN=1 bash scripts/install-service.sh install               # print rendered file only
#   FORCE_OS=debian DRY_RUN=1 bash scripts/install-service.sh install  # preview the other branch
#   bash scripts/install-service.sh uninstall                       # stop and remove it
# Invoked via `make install-service` / `make uninstall-service`, which pass DRY_RUN/FORCE_OS
# through from the command line automatically.
set -euo pipefail
cd "$(dirname "$0")/.." || exit 1
# shellcheck source=scripts/lib.sh
. scripts/lib.sh

USAGE="usage: bash scripts/install-service.sh [install|uninstall]"
ACTION="${1:-install}"
case "$ACTION" in
  install|uninstall) ;;
  *) echo "$USAGE" >&2; exit 2 ;;
esac

DRY_RUN="${DRY_RUN:-0}"
FORCE_OS="${FORCE_OS:-}" # testing-only override so the systemd branch can be reviewed from macOS
case "$FORCE_OS" in
  ""|macos|debian) ;;
  *) echo "ERROR: FORCE_OS must be macos or debian (got: $FORCE_OS)" >&2; exit 2 ;;
esac

if [ -n "$FORCE_OS" ]; then
  OS_FAMILY="$FORCE_OS"
elif is_macos; then
  OS_FAMILY=macos
elif is_debianish || has_systemd; then
  OS_FAMILY=debian
else
  echo "ERROR: unsupported platform $(uname -s) for install-service (supported: macOS, systemd Linux)" >&2
  echo "FIX: skip the resident service and run bun run src/cli.ts serve under your own supervisor" >&2
  exit 3
fi

REPO_ROOT="$(pwd -P)"
if [ "$OS_FAMILY" = macos ]; then
  LABEL="com.minime.serve"
  TEMPLATE="ops/service/com.minime.serve.plist.tmpl"
  TARGET_DIR="$HOME/Library/LaunchAgents"
  TARGET="$TARGET_DIR/$LABEL.plist"
else
  LABEL="minime"
  TEMPLATE="ops/service/minime.service.tmpl"
  TARGET_DIR="$HOME/.config/systemd/user"
  TARGET="$TARGET_DIR/$LABEL.service"
fi

if [ "$ACTION" = uninstall ]; then
  if [ "$DRY_RUN" = 1 ]; then
    echo "# DRY_RUN: would stop and remove $TARGET"
    exit 0
  fi
  if [ "$OS_FAMILY" = macos ]; then
    launchctl bootout "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || true
  else
    systemctl --user disable --now "$LABEL.service" >/dev/null 2>&1 || true
    systemctl --user daemon-reload >/dev/null 2>&1 || true
  fi
  rm -f -- "$TARGET"
  echo "removed: $TARGET"
  exit 0
fi

# ACTION=install
[ -f "$TEMPLATE" ] || { echo "ERROR: missing template $TEMPLATE" >&2; exit 10; }

BUN_PATH="$(command -v bun 2>/dev/null || true)"
if [ -z "$BUN_PATH" ] && [ -x "$HOME/.bun/bin/bun" ]; then
  BUN_PATH="$HOME/.bun/bin/bun"
fi
if [ -z "$BUN_PATH" ]; then
  echo "ERROR: bun not found on PATH or at \$HOME/.bun/bin/bun" >&2
  echo "FIX: run bash scripts/install.sh first" >&2
  exit 10
fi

RENDERED="$(sed \
  -e "s#@REPO_ROOT@#$REPO_ROOT#g" \
  -e "s#@BUN_PATH@#$BUN_PATH#g" \
  -e "s#@HOME@#$HOME#g" \
  "$TEMPLATE")"
if printf '%s\n' "$RENDERED" | grep -qE '@[A-Za-z0-9_]+@'; then
  echo "ERROR: rendered $TEMPLATE still has an unresolved @placeholder@ token" >&2
  exit 20
fi

if [ "$DRY_RUN" = 1 ]; then
  echo "# DRY_RUN: would write $TARGET"
  printf '%s\n' "$RENDERED"
  exit 0
fi

mkdir -p data/logs && chmod 700 data/logs
mkdir -p "$TARGET_DIR"
TMP_TARGET="$TARGET.tmp.$$"
( umask 077; printf '%s\n' "$RENDERED" > "$TMP_TARGET" )
mv -f -- "$TMP_TARGET" "$TARGET"

if [ "$OS_FAMILY" = macos ]; then
  launchctl bootout "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || true
  launchctl bootstrap "gui/$(id -u)" "$TARGET"
  echo "installed: $TARGET"
  echo "check: launchctl list | grep minime"
else
  systemctl --user daemon-reload
  systemctl --user enable "$LABEL.service"
  systemctl --user restart "$LABEL.service"
  echo "installed: $TARGET"
  echo "check: systemctl --user status $LABEL"
fi
