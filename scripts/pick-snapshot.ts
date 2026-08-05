// Compatibility helper for restore-pitr.sh's logical snapshot restore (not WAL/PITR): from
// `restic snapshots --json`, pick the latest snapshot (tags db-snap or dream — the two pg_dump-
// bearing groups) whose time is at or before TIME.
// Prints "<short_id>\t<iso-time>" on success; exits 3 with a message when nothing qualifies.
//
// Why a TS helper instead of jq: jq isn't a pinned dependency and date math in shell is
// brittle across BSD/GNU; Bun gives us reliable JSON + Date parsing with zero new deps.

type Snapshot = {
  id: string;
  short_id?: string;
  time: string;
  tags?: string[];
};

const SNAPSHOT_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function validSnapshot(value: unknown): value is Snapshot {
  if (!isRecord(value)) return false;
  if (typeof value.id !== "string" || !SNAPSHOT_ID.test(value.id)) return false;
  if (typeof value.time !== "string" || !Number.isFinite(Date.parse(value.time))) return false;
  if (
    value.short_id !== undefined &&
    (typeof value.short_id !== "string" || !SNAPSHOT_ID.test(value.short_id))
  )
    return false;
  if (
    value.tags !== undefined &&
    (!Array.isArray(value.tags) || !value.tags.every((tag) => typeof tag === "string"))
  )
    return false;
  return true;
}

export {};

const TIME = process.env.TIME?.trim();
const LATEST = process.env.LATEST === "1";
if ((!TIME && !LATEST) || (TIME && LATEST)) {
  console.error("pick-snapshot: selection mode must be exactly TIME or LATEST");
  process.exit(2);
}

// TIME is a local wall-clock string ("2026-06-12 14:30"); Date parses the space form on Bun,
// but normalize to the "T" form so it's interpreted consistently as local time.
const cutoff = TIME ? new Date(TIME.replace(" ", "T")) : undefined;
if (cutoff && !Number.isFinite(cutoff.getTime())) {
  console.error("pick-snapshot: cannot parse TIME");
  process.exit(2);
}

let snapshots: unknown;
try {
  snapshots = JSON.parse(await new Response(Bun.stdin).text());
} catch {
  console.error("pick-snapshot: invalid restic JSON");
  process.exit(2);
}
if (!Array.isArray(snapshots)) {
  console.error("pick-snapshot: invalid restic JSON");
  process.exit(2);
}

const eligible = snapshots
  .filter(validSnapshot)
  .filter((s) => s.tags?.some((t) => t === "db-snap" || t === "dream"))
  .filter((s) => cutoff === undefined || Date.parse(s.time) <= cutoff.getTime())
  .sort((a, b) => Date.parse(b.time) - Date.parse(a.time));

const picked = eligible[0];
if (!picked) {
  console.error("pick-snapshot: no eligible db-snap/dream snapshot");
  process.exit(3);
}

console.log(`${picked.short_id ?? picked.id}\t${picked.time}`);
