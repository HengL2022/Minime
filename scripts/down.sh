#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck source=scripts/lib.sh
MINIME_LIB_SKIP_RESOLVE=1
. scripts/lib.sh

[ -f .env ] || {
  echo "ERROR: .env is required before stopping an installed PostgreSQL backend." >&2
  echo "FIX: do not infer service ownership; run bash scripts/install.sh first." >&2
  exit 40
}

if ! resolve_pg_lifecycle .env 0; then
  echo "ERROR: Postgres lifecycle state is invalid ($PG_STATE_RULE)." >&2
  echo "FIX: repair DATABASE_URL, MINIME_PG_BACKEND, and MINIME_PG_PORT in .env before retrying." >&2
  exit 40
fi

selected_pg_backend_safe_to_stop || {
  echo "ERROR: persisted PostgreSQL backend/port does not identify the service that would be stopped." >&2
  echo "FIX: reconcile .env with the selected service; Minime refused to stop an unidentified service." >&2
  exit 21
}

if [ "$PG_STATE_NEEDS_PERSIST" = 1 ] && [ -f .env ]; then
  persist_pg_lifecycle .env 0 || {
    echo "ERROR: could not persist PostgreSQL lifecycle state." >&2
    echo "FIX: check .env permissions, then retry." >&2
    exit 40
  }
fi

if [ "$PG_BACKEND" = docker ]; then
  docker_available || {
    echo "ERROR: persisted Docker backend is unavailable." >&2
    echo "FIX: start Docker, then retry; Minime will not stop a different backend." >&2
    exit 22
  }
  MINIME_PG_PORT="$PG_PORT" docker compose down
elif ! native_running_backend_matches_port "$PG_PORT"; then
  # The configured native identity is known and already stopped: repeated down is a no-op.
  :
elif is_macos; then
  brew services stop postgresql@17
elif is_debianish; then
  SUDO=""
  [ "$(id -u)" = 0 ] || SUDO="sudo -n"
  if has_systemd; then
    $SUDO systemctl stop "postgresql@16-main" || $SUDO pg_ctlcluster 16 main stop
  else
    $SUDO pg_ctlcluster 16 main stop
  fi
else
  echo "ERROR: unsupported persisted native backend platform." >&2
  exit 3
fi
