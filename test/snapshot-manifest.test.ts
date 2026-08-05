import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildSnapshotManifest,
  publishSnapshotManifest,
  readSnapshotManifest,
  verifySnapshotManifest,
} from "../src/ops/snapshot-manifest";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    try {
      Bun.spawnSync(["/bin/rm", "-rf", "--", root]);
    } catch {
      // best effort fixture cleanup
    }
  }
});

const dump = [
  "-- PostgreSQL database dump",
  "SET statement_timeout = 0;",
  "COPY public.schema_migrations (name, applied_at) FROM stdin;",
  "020_search.sql\t2026-08-01 00:00:00+00",
  "019_orgs.sql\t2026-08-01 00:00:00+00",
  "\\.",
  "COPY public.tasks (id, title) FROM stdin;",
  "1\tfictional task",
  "2\tsecond fictional task",
  "\\.",
  "COPY public.people (id, display_name) FROM stdin;",
  "1\tAda",
  "\\.",
  "COPY public.journal_entries (id, body) FROM stdin;",
  "1\tfictional journal",
  "\\.",
  "COPY public.chunks (id, content) FROM stdin;",
  "1\tfictional chunk",
  "2\tsecond fictional chunk",
  "3\tthird fictional chunk",
  "\\.",
  "COPY public.events (id, event_type) FROM stdin;",
  "1\tcapture",
  "\\.",
  "",
].join("\n");

describe("snapshot manifest", () => {
  test("derives a digest, sorted migration ledger, and representative COPY counts", () => {
    const manifest = buildSnapshotManifest(dump);
    expect(manifest.version).toBe(1);
    expect(manifest.dump_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest.schema_migrations).toEqual(["019_orgs.sql", "020_search.sql"]);
    expect(manifest.counts).toEqual({
      tasks: 2,
      people: 1,
      journal_entries: 1,
      chunks: 3,
      events: 1,
    });
  });

  test("rejects a dump that is missing a representative COPY section", () => {
    expect(() => buildSnapshotManifest(dump.replace(/COPY public.events[\s\S]*$/, ""))).toThrow(
      "snapshot manifest failed (dump_structure)",
    );
  });

  test("publishes a private manifest and verifies the exact dump bytes", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "minime-manifest-test-")));
    roots.push(root);
    chmodSync(root, 0o700);
    const dumpPath = join(root, "minime.sql");
    writeFileSync(dumpPath, dump, { mode: 0o600 });
    const manifestPath = await publishSnapshotManifest(root, dumpPath);
    expect(manifestPath).toBe(join(root, "minime.manifest.json"));
    expect(lstatSync(manifestPath).isSymbolicLink()).toBe(false);
    expect(statSync(manifestPath).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(manifestPath, "utf8")).counts.events).toBe(1);
    await expect(verifySnapshotManifest(dumpPath, manifestPath)).resolves.toBeUndefined();
    writeFileSync(dumpPath, `${dump}-- changed\n`);
    await expect(verifySnapshotManifest(dumpPath, manifestPath)).rejects.toThrow(
      "snapshot manifest failed (digest)",
    );
  });

  test("read rejects unknown fields and malformed manifests before restore", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "minime-manifest-test-")));
    roots.push(root);
    chmodSync(root, 0o700);
    const path = join(root, "minime.manifest.json");
    writeFileSync(path, JSON.stringify({ version: 1, unexpected: true }), { mode: 0o600 });
    await expect(readSnapshotManifest(path)).rejects.toThrow("snapshot manifest failed (format)");
  });

  test("count comparison fails closed when a restored representative count drifts", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "minime-manifest-test-")));
    roots.push(root);
    chmodSync(root, 0o700);
    const dumpPath = join(root, "minime.sql");
    const manifestPath = join(root, "minime.manifest.json");
    writeFileSync(dumpPath, dump, { mode: 0o600 });
    await publishSnapshotManifest(root, dumpPath);
    const rows =
      "m\t019_orgs.sql\t-\nm\t020_search.sql\t-\nc\tchunks\t2\nc\tevents\t1\nc\tjournal_entries\t1\nc\tpeople\t1\nc\ttasks\t999\n";
    const proc = Bun.spawn(
      [Bun.which("bun")!, "run", "scripts/snapshot-manifest.ts", "compare", manifestPath],
      {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    proc.stdin.write(rows);
    proc.stdin.end();
    expect(await proc.exited).toBe(1);
    expect(await new Response(proc.stderr).text()).toContain("snapshot manifest failed (counts)");
  });
});
