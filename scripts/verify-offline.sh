#!/bin/bash
# One authoritative offline development gate. All callers use this coordinator so the
# advertised checks cannot drift between Make, install, and update.
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck source=scripts/lib.sh
MINIME_LIB_SKIP_RESOLVE=1
. scripts/lib.sh

if ! pinned_bun_matches; then
  required="$(pinned_bun_version 2>/dev/null || printf 'unknown')"
  echo "ERROR: exact Bun $required is required for offline verification." >&2
  echo "FIX: run bash scripts/install.sh to install the repository pin, then retry." >&2
  exit 10
fi

export MINIME_MOCK_OLLAMA=1
bun run scripts/with-test-database.ts --label verify_m0 -- \
  bun run src/verify/m0.ts
bun test
bun run lint
bun run typecheck
bun run typecheck:ops
bun run scripts/check-subsystems.ts
