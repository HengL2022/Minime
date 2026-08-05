#!/usr/bin/env bun
import { dirname } from "node:path";
import {
  publishSnapshotManifest,
  readSnapshotManifest,
  verifySnapshotManifest,
} from "../src/ops/snapshot-manifest";

const [command, firstPath, secondPath] = process.argv.slice(2);
if (
  (command !== "write" && command !== "verify" && command !== "compare") ||
  !firstPath ||
  (command !== "compare" && !secondPath) ||
  process.argv.length !== (command === "compare" ? 4 : 5)
) {
  console.error("snapshot manifest failed (usage)");
  process.exit(2);
}

try {
  if (command === "write") {
    const published = await publishSnapshotManifest(dirname(firstPath), firstPath);
    if (published !== secondPath) throw new Error("snapshot manifest failed (ownership)");
  } else if (command === "verify") {
    await verifySnapshotManifest(firstPath, secondPath!);
  } else {
    const manifest = await readSnapshotManifest(firstPath);
    const rows = (await new Response(Bun.stdin).text()).trimEnd().split("\n").filter(Boolean);
    const migrations: string[] = [];
    const counts: Record<string, number> = {};
    const expectedCounts = manifest.counts as Record<string, number>;
    for (const row of rows) {
      const fields = row.split("\t");
      if (
        fields[0] === "m" &&
        (fields.length === 2 || (fields.length === 3 && fields[2] === "-")) &&
        fields[1]
      )
        migrations.push(fields[1]);
      else if (fields[0] === "c" && fields.length === 3 && fields[1] && /^\d+$/.test(fields[2]!))
        counts[fields[1]] = Number(fields[2]);
      else throw new Error("snapshot manifest failed (counts)");
    }
    if (
      JSON.stringify(migrations) !== JSON.stringify(manifest.schema_migrations) ||
      ["tasks", "people", "journal_entries", "chunks", "events"].some(
        (table) => counts[table] !== expectedCounts[table],
      ) ||
      Object.keys(counts).length !== 5
    )
      throw new Error("snapshot manifest failed (counts)");
  }
} catch (error) {
  console.error(
    error instanceof Error && error.message.startsWith("snapshot manifest failed")
      ? error.message
      : "snapshot manifest failed (filesystem)",
  );
  process.exit(1);
}
