#!/usr/bin/env bash
# PrecisionMemBench run: their ava harness drives our pmb-server over HTTP, their scorer
# writes JSON reports, eval-pmb-report.ts renders the dated scorecard. Ava exit codes are
# tolerated (structurally-failing cases are expected and published); a missing report is not.
set -euo pipefail
cd "$(dirname "$0")/.."

PMB_DIR="${PMB_DIR:-$HOME/datasets/precisionmembench}"
EVAL_PMB_DATABASE_URL="${EVAL_PMB_DATABASE_URL:-postgres://minime:minime@localhost:5432/minime_eval_pmb}"
PORT="${PMB_PORT:-8077}"
ROUND="${ROUND:-r1}"

if [ ! -d "$PMB_DIR" ]; then
  echo "ERROR: harness not found — git clone https://github.com/tenurehq/precisionmembench $PMB_DIR" >&2
  exit 2
fi

createdb "${EVAL_PMB_DATABASE_URL##*/}" 2>/dev/null || true

# register the provider in the (scratch, uncommitted) harness clone — idempotent
python3 - "$PMB_DIR/providers.config.json" <<'EOF'
import json, sys
path = sys.argv[1]
cfg = json.load(open(path))
cfg.setdefault("minime", {
    "envVar": "MINIME_PMB_URL",
    "defaultUrl": "http://localhost:8077",
    "seedDelayMs": 0,
    "beliefToText": "canonical_name_aliases",
    "supportsUpdate": True,
})
json.dump(cfg, open(path, "w"), indent=2)
EOF

if [ ! -d "$PMB_DIR/node_modules" ]; then
  (cd "$PMB_DIR" && npm install --silent)
fi

DATABASE_URL="$EVAL_PMB_DATABASE_URL" EVAL_PMB_DATABASE_URL="$EVAL_PMB_DATABASE_URL" \
  PMB_PORT="$PORT" bun run scripts/pmb-server.ts &
SERVER_PID=$!
trap 'kill "$SERVER_PID" 2>/dev/null || true' EXIT

for _ in $(seq 1 100); do
  curl -fsS "http://localhost:$PORT/health" >/dev/null 2>&1 && break
  kill -0 "$SERVER_PID" 2>/dev/null || { echo "ERROR: pmb-server exited during startup" >&2; exit 1; }
  sleep 0.2
done

(
  cd "$PMB_DIR"
  MEMORY_PROVIDER=minime RESEED=true MINIME_PMB_URL="http://localhost:$PORT" \
    npx ava src/retrieval.external.eval.test.ts || true
  MEMORY_PROVIDER=minime RESEED=true MINIME_PMB_URL="http://localhost:$PORT" \
    npx ava src/session-retrieval.external.eval.test.ts || true
)

bun run scripts/eval-pmb-report.ts "$PMB_DIR/test-results" --round "$ROUND"
