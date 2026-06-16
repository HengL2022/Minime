#!/bin/bash
# Guided, interactive .env setup: LLM provider credentials and backup storage. The
# complement to scripts/install.sh, which is non-interactive by contract (AGENTS.md) —
# run this first (or never: the local-Ollama defaults need no credentials at all).
# Entered secrets (provider keys, B2/S3 keys) go into .env (chmod 600, never committed —
# spec §12) and are never echoed. The one exception is the generated restic backup password:
# it is shown on screen exactly once, at creation, so the owner can record the key that
# decrypts off-machine cloud backups (losing it makes the backup unrecoverable).
# Safe to re-run: existing .env is backed up, answers default to current values.
# macOS bash-3.2 clean.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1
umask 077

ENVF=".env"

ask() { # prompt default -> REPLY
  printf '%s [%s]: ' "$1" "$2"
  read -r REPLY
  [ -z "$REPLY" ] && REPLY="$2"
}

ask_secret() { # prompt -> REPLY (empty keeps existing)
  printf '%s (hidden, empty = keep current): ' "$1"
  read -rs REPLY
  echo
}

set_kv() { # KEY VALUE — replace the line (commented or not) or append
  local tmp
  tmp="$(mktemp)"
  awk -v k="$1" -v v="$2" '
    !done && $0 ~ "^#?"k"=" { print k"="v; done=1; next }
    { print }
    END { if (!done) print k"="v }
  ' "$ENVF" >"$tmp" && mv "$tmp" "$ENVF"
}

get_kv() { # KEY -> current value or empty
  sed -n "s/^$1=//p" "$ENVF" | head -1
}

echo "Minime guided setup — writes $ENVF (stays on this machine, never committed)."
echo "Press Enter to accept the [default] at any prompt."
echo

# --- .env scaffold --------------------------------------------------------------
if [ -f "$ENVF" ]; then
  cp "$ENVF" "$ENVF.bak-$(date +%Y%m%d-%H%M%S)"
  echo "existing $ENVF backed up alongside it"
else
  cp .env.example "$ENVF"
fi
chmod 600 "$ENVF"

# --- timezone ---------------------------------------------------------------------
ask "Timezone (IANA name)" "$(get_kv TZ)"
set_kv TZ "$REPLY"

# --- LLM stack ----------------------------------------------------------------------
echo
echo "Model stack — embeddings + inbox classification:"
echo "  1) local Ollama        — fully private, no credentials, ~6 GB of models"
echo "  2) cloud provider(s)   — no local models; content up to CLOUD_MAX_TIER leaves"
echo "                           the box (tier-0 money/health NEVER does; all egress audited)"
ask "Choice" "1"
if [ "$REPLY" = "2" ]; then
  echo
  echo "Classification provider: 1) bedrock (IAM)  2) anthropic  3) openai  4) openrouter"
  ask "Choice" "1"
  case "$REPLY" in
    2) set_kv CLASSIFY_PROVIDER anthropic
       ask_secret "ANTHROPIC_API_KEY"; [ -n "$REPLY" ] && set_kv ANTHROPIC_API_KEY "$REPLY" ;;
    3) set_kv CLASSIFY_PROVIDER openai
       ask_secret "OPENAI_API_KEY"; [ -n "$REPLY" ] && set_kv OPENAI_API_KEY "$REPLY" ;;
    4) set_kv CLASSIFY_PROVIDER openrouter
       ask_secret "OPENROUTER_API_KEY"; [ -n "$REPLY" ] && set_kv OPENROUTER_API_KEY "$REPLY" ;;
    *) set_kv CLASSIFY_PROVIDER bedrock
       ask "BEDROCK_MODEL (see: aws bedrock list-inference-profiles)" "us.anthropic.claude-opus-4-8"
       set_kv BEDROCK_MODEL "$REPLY"
       ask "AWS_REGION" "${AWS_REGION:-us-east-1}"; set_kv AWS_REGION "$REPLY"
       echo "AWS credentials: leave empty to use ~/.aws (recommended)"
       ask_secret "AWS_ACCESS_KEY_ID"; [ -n "$REPLY" ] && set_kv AWS_ACCESS_KEY_ID "$REPLY"
       ask_secret "AWS_SECRET_ACCESS_KEY"; [ -n "$REPLY" ] && set_kv AWS_SECRET_ACCESS_KEY "$REPLY" ;;
  esac
  echo
  echo "Embedding provider (768 dims pinned): 1) openrouter (qwen3-embedding-8b)  2) openai  3) keep local ollama"
  ask "Choice" "1"
  case "$REPLY" in
    2) set_kv EMBED_PROVIDER openai
       ask_secret "OPENAI_API_KEY"; [ -n "$REPLY" ] && set_kv OPENAI_API_KEY "$REPLY" ;;
    3) ;; # ollama stays the .env default
    *) set_kv EMBED_PROVIDER openrouter
       ask_secret "OPENROUTER_API_KEY"; [ -n "$REPLY" ] && set_kv OPENROUTER_API_KEY "$REPLY" ;;
  esac
  ask "CLOUD_MAX_TIER — 2 sends journal/interactions too; 1 keeps them local-only" "2"
  set_kv CLOUD_MAX_TIER "$REPLY"
  echo "NOTE: if you changed the embedding provider on an existing database, run:"
  echo "      bun run src/cli.ts reembed"
  INSTALL_FLAGS=" --no-ollama"
else
  INSTALL_FLAGS=""
fi

# --- backups ---------------------------------------------------------------------------
echo
echo "Backups (restic, client-side encrypted either way):"
echo "  1) local/mounted disk path   2) Backblaze B2   3) S3   4) skip for now"
ask "Choice" "1"
BACKUP=configured
case "$REPLY" in
  2) ask "B2 bucket name" "minime-backup"
     set_kv RESTIC_REPOSITORY "b2:$REPLY:restic"
     ask "B2_ACCOUNT_ID" ""; [ -n "$REPLY" ] && set_kv B2_ACCOUNT_ID "$REPLY"
     ask_secret "B2_ACCOUNT_KEY"; [ -n "$REPLY" ] && set_kv B2_ACCOUNT_KEY "$REPLY" ;;
  3) ask "S3 repository (e.g. s3:s3.amazonaws.com/minime-backup)" "s3:s3.amazonaws.com/minime-backup"
     set_kv RESTIC_REPOSITORY "$REPLY"
     ask_secret "AWS_ACCESS_KEY_ID"; [ -n "$REPLY" ] && set_kv AWS_ACCESS_KEY_ID "$REPLY"
     ask_secret "AWS_SECRET_ACCESS_KEY"; [ -n "$REPLY" ] && set_kv AWS_SECRET_ACCESS_KEY "$REPLY" ;;
  4) set_kv BACKUP_CRON '""'
     BACKUP=skipped
     echo "skipped — re-run this script anytime; until then there are NO backups" ;;
  *) ask "Backup directory" "$HOME/minime-restic"
     set_kv RESTIC_REPOSITORY "$REPLY" ;;
esac

if [ "$BACKUP" = configured ]; then
  # honor a path already configured in .env (~ expanded); default otherwise
  PASSF="$(get_kv RESTIC_PASSWORD_FILE)"
  PASSF="${PASSF/#\~/$HOME}"
  [ -z "$PASSF" ] && PASSF="$HOME/.config/minime/restic.pass"
  if [ ! -f "$PASSF" ]; then
    mkdir -p "$(dirname "$PASSF")"
    if command -v openssl >/dev/null 2>&1; then openssl rand -base64 32 >"$PASSF"
    else head -c 32 /dev/urandom | base64 >"$PASSF"; fi
    chmod 600 "$PASSF"
    echo "created restic password file: $PASSF"
    echo "BACK THIS FILE UP somewhere safe — without it, backups are unrecoverable."
    echo
    echo "  ============================================================"
    echo "  RESTIC BACKUP PASSWORD — shown ONCE. Write it down NOW."
    echo "  ============================================================"
    echo
    echo "      $(cat "$PASSF")"
    echo
    echo "  This password decrypts your cloud backup. Lose BOTH it and"
    echo "  this machine and the backup is unrecoverable by anyone —"
    echo "  including you. Store it in a password manager or on paper,"
    echo "  kept separate from this machine. (Also saved to: $PASSF)"
    printf '\nPress Enter once you have written it down... '
    read -r _
  fi
  set_kv RESTIC_PASSWORD_FILE "$PASSF"
  if command -v restic >/dev/null 2>&1; then
    ask "Initialize the restic repository now? (y/N)" "n"
    case "$REPLY" in
      y|Y) set -a; . ./"$ENVF"; set +a
           restic init 2>&1 | tail -2 || echo "(already initialized or unreachable — fine to retry later)" ;;
    esac
  else
    echo "restic not installed yet — 'brew install restic' / 'apt install restic', then: restic init"
  fi
fi

# --- done -----------------------------------------------------------------------------
echo
echo "==== SETUP COMPLETE ===="
echo "wrote: $ENVF (chmod 600)"
echo "next:  bash scripts/install.sh$INSTALL_FLAGS"
echo "then:  bun run src/cli.ts serve     # MCP server + watcher + nightly maintenance"
echo "docs:  docs/GUIDE.md (owner's manual) · AGENTS.md (agent install contract)"
