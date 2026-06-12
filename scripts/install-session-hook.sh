#!/bin/bash
# Owner-run installer for the SessionEnd episodic-capture hook (DECISIONS.md 2026-06-12).
# Merges one hook entry into ~/.claude/settings.json (global: captures every Claude Code
# session into Minime's inbox) after an explicit confirmation, backing the file up first.
# Idempotent: re-running detects the existing entry and exits. macOS bash-3.2 clean.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
HOOK="$REPO_DIR/agents/hooks/session-capture.sh"
DATA_DIR="${MINIME_DATA_DIR:-$REPO_DIR/data}"
SETTINGS="${CLAUDE_SETTINGS:-$HOME/.claude/settings.json}"
CMD="MINIME_DATA_DIR='$DATA_DIR' '$HOOK'"

echo "This adds a SessionEnd hook to $SETTINGS so every Claude Code session"
echo "(across all projects) drops a summary into $DATA_DIR/inbox."
printf 'Install? [y/N] '
read -r answer
case "$answer" in y|Y|yes|YES) ;; *) echo "aborted"; exit 1 ;; esac

SETTINGS="$SETTINGS" CMD="$CMD" python3 <<'PYEOF'
import json, os, shutil, time

settings_path = os.environ["SETTINGS"]
cmd = os.environ["CMD"]
data = {}
if os.path.isfile(settings_path):
    backup = "%s.bak-%s" % (settings_path, time.strftime("%Y%m%d-%H%M%S"))
    shutil.copyfile(settings_path, backup)
    print("backup: %s" % backup)
    with open(settings_path, encoding="utf-8") as f:
        data = json.load(f)

entries = data.setdefault("hooks", {}).setdefault("SessionEnd", [])
existing = [h.get("command", "") for e in entries for h in e.get("hooks", [])]
if any("session-capture.sh" in c for c in existing):
    print("already installed; nothing to do")
else:
    entries.append({"hooks": [{"type": "command", "command": cmd}]})
    os.makedirs(os.path.dirname(settings_path), exist_ok=True)
    with open(settings_path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)
        f.write("\n")
    print("installed SessionEnd hook -> %s" % cmd)
PYEOF
