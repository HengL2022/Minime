#!/bin/bash
# PreToolUse hook: block Bash commands that drop or rename the live `minime` database.
# Restores must land in a scratch DB (minime_restore, minime_drill, ...); promotion is a
# deliberate owner step via `make promote-restore` (incident 2026-06-12: a runner reset the
# real DB). Scratch DBs are intentionally not protected — the trailing [^_a-zA-Z0-9] keeps
# minime_* names out of the match.
input=$(cat)
cmd=$(printf '%s' "$input" | python3 -c "import json,sys; print(json.load(sys.stdin).get('tool_input',{}).get('command',''))" 2>/dev/null)
[ -z "$cmd" ] && exit 0

live='"?minime"?([^_a-zA-Z0-9]|$)'
if printf '%s' "$cmd" | grep -Eiq "dropdb[^;|&]*[[:space:]]$live" ||
   printf '%s' "$cmd" | grep -Eiq "drop[[:space:]]+database[[:space:]]+(if[[:space:]]+exists[[:space:]]+)?$live" ||
   printf '%s' "$cmd" | grep -Eiq "alter[[:space:]]+database[[:space:]]+$live"; then
  echo "Blocked: this command drops or renames the live 'minime' database. Work in a scratch DB (minime_restore / minime_drill); promoting a restore is owner-run via 'make promote-restore'." >&2
  exit 2
fi
exit 0
