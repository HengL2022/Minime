#!/bin/bash
# PostToolUse hook: auto-format edited TS/JS/JSON files with biome (spec §4 pins biome).
# Silently no-ops until biome is configured (pre-M0) or if bun is unavailable.
input=$(cat)
file=$(printf '%s' "$input" | python3 -c "import json,sys; print(json.load(sys.stdin).get('tool_input',{}).get('file_path',''))" 2>/dev/null)
[ -z "$file" ] || [ ! -f "$file" ] && exit 0

case "$file" in
  *.ts|*.tsx|*.js|*.json|*.jsonc) ;;
  *) exit 0 ;;
esac

root="${CLAUDE_PROJECT_DIR:-$(pwd)}"
if command -v bunx >/dev/null 2>&1 && [ -f "$root/biome.json" ]; then
  (cd "$root" && bunx biome check --write "$file" >/dev/null 2>&1)
fi
exit 0
