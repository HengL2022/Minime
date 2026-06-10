#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  docker compose down
else
  brew services stop postgresql@17 || true
fi
