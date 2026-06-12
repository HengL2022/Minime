// Helper for restore-pitr.sh: from `restic snapshots --json`, pick the latest snapshot
// (tags db-snap or dream — the two pg_dump-bearing groups) whose time is at or before TIME.
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

const TIME = process.env.TIME;
if (!TIME) {
  console.error("pick-snapshot: TIME not set");
  process.exit(2);
}

// TIME is a local wall-clock string ("2026-06-12 14:30"); Date parses the space form on Bun,
// but normalize to the "T" form so it's interpreted consistently as local time.
const cutoff = new Date(TIME.trim().replace(" ", "T"));
if (Number.isNaN(cutoff.getTime())) {
  console.error(`pick-snapshot: cannot parse TIME=${JSON.stringify(TIME)}`);
  process.exit(2);
}

let snapshots: Snapshot[];
try {
  snapshots = JSON.parse(await new Response(Bun.stdin).text());
} catch (e) {
  console.error(`pick-snapshot: invalid restic JSON: ${e instanceof Error ? e.message : e}`);
  process.exit(2);
}

const eligible = snapshots
  .filter((s) => s.tags?.some((t) => t === "db-snap" || t === "dream"))
  .filter((s) => new Date(s.time).getTime() <= cutoff.getTime())
  .sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime());

const picked = eligible[0];
if (!picked) {
  console.error(`pick-snapshot: no db-snap/dream snapshot at or before "${TIME}"`);
  process.exit(3);
}

console.log(`${picked.short_id ?? picked.id}\t${picked.time}`);
