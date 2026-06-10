#!/bin/bash
# PreToolUse hook: block edits to secrets files (.env is never committed, spec §12).
input=$(cat)
file=$(printf '%s' "$input" | python3 -c "import json,sys; print(json.load(sys.stdin).get('tool_input',{}).get('file_path',''))" 2>/dev/null)
[ -z "$file" ] && exit 0

base=$(basename "$file")
case "$base" in
  .env.example) exit 0 ;;
  .env|.env.*)
    echo "Blocked: $base is a secrets file and must never be committed or edited by the agent (spec §12). Update .env.example instead and tell the owner what to set." >&2
    exit 2 ;;
  restic.pass)
    echo "Blocked: restic password file must only be touched by the owner (spec §12)." >&2
    exit 2 ;;
esac
exit 0
