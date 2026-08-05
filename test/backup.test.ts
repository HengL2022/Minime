// Backup module — fully offline (I1): restic/pg_dump are never invoked. The unconfigured
// path returns { ran: false } without touching binaries; the overlap guard short-circuits
// on the module-level in-flight flag before any config/binary check.

import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cron } from "croner";
import {
  PREVIOUS_SNAPSHOT_DUMP_BASENAME,
  PREVIOUS_SNAPSHOT_MANIFEST_BASENAME,
  buildSnapshotManifest,
  publishSnapshotManifest,
  readSnapshotManifest,
} from "../src/ops/snapshot-manifest";
import {
  __setCommandRunnerForTest,
  __setDumpDirForTest,
  __setInFlightForTest,
  __setManifestWriterForTest,
  __setProbeHookForTest,
  backup,
  dbSnapshot,
  preUpdateSnapshot,
} from "../src/pipeline/backup";
import { config } from "../src/util/config";

afterEach(() => {
  __setInFlightForTest(false);
  __setProbeHookForTest(undefined);
  __setCommandRunnerForTest(undefined);
  config.resticRepository = undefined;
  config.resticPasswordFile = undefined;
  __setDumpDirForTest(undefined);
  __setManifestWriterForTest(undefined);
});

describe("graceful degradation when restic is unconfigured", () => {
  test("dbSnapshot() resolves { ran: false } and detail mentions configuration", async () => {
    // setup.ts leaves RESTIC_REPOSITORY unset; config reads it at import.
    expect(config.resticRepository).toBeUndefined();
    const r = await dbSnapshot();
    expect(r.ran).toBe(false);
    expect(r.detail).toMatch(/not configured/i);
  });

  test("backup() resolves { ran: false } and detail mentions configuration", async () => {
    const r = await backup();
    expect(r.ran).toBe(false);
    expect(r.detail).toMatch(/not configured/i);
  });

  test("preUpdateSnapshot reports unconfigured only when both settings are absent", async () => {
    const output: string[] = [];
    const originalLog = console.log;
    console.log = (line?: unknown) => output.push(String(line));
    try {
      await expect(preUpdateSnapshot()).resolves.toEqual({ kind: "unconfigured" });
    } finally {
      console.log = originalLog;
    }
    expect(output).toEqual(["backup:pre-update unconfigured"]);
  });

  test("preUpdateSnapshot fails closed for partial configuration", async () => {
    config.resticRepository = "test:repo";
    const calls: string[][] = [];
    __setCommandRunnerForTest(async (cmd) => {
      calls.push(cmd);
      return { ok: true };
    });
    const output: string[] = [];
    const originalLog = console.log;
    console.log = (line?: unknown) => output.push(String(line));
    try {
      await expect(preUpdateSnapshot()).resolves.toEqual({ kind: "failed" });
    } finally {
      console.log = originalLog;
    }
    expect(calls).toEqual([]);
    expect(output).toEqual(["backup:pre-update failed"]);
  });

  test("preUpdateSnapshot maps configured dbSnapshot failure to failed", async () => {
    config.resticRepository = "test:repo";
    config.resticPasswordFile = "/test/pass";
    __setCommandRunnerForTest(async () => ({ ok: false, failure: "exit_nonzero" }));
    const output: string[] = [];
    const originalLog = console.log;
    console.log = (line?: unknown) => output.push(String(line));
    try {
      await expect(preUpdateSnapshot()).resolves.toEqual({ kind: "failed" });
    } finally {
      console.log = originalLog;
    }
    expect(output).toEqual(["backup:pre-update failed"]);
  });
});

describe("in-flight overlap guard", () => {
  test("dbSnapshot() skips while a backup is in flight", async () => {
    __setInFlightForTest(true);
    const r = await dbSnapshot();
    expect(r.ran).toBe(false);
    expect(r.detail).toMatch(/in flight/i);
  });

  test("backup() skips while a snapshot is in flight", async () => {
    __setInFlightForTest(true);
    const r = await backup();
    expect(r.ran).toBe(false);
    expect(r.detail).toMatch(/in flight/i);
  });

  test("concurrent invocations: the flag is claimed before any await, so the second skips (B2)", async () => {
    // The probe hook fires immediately after inFlight is claimed, BEFORE the config/binary
    // checks — opening a held-flag await window without ever touching restic/pg_dump (I1).
    // The pre-fix code claimed the flag only AFTER awaiting the binary probe, so two callers
    // entering in the same tick both passed the `if (inFlight)` gate and raced into pg_dump.
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let hookFired = false;
    __setProbeHookForTest(() => {
      hookFired = true;
      return gate; // the admitted caller parks here, holding inFlight = true
    });

    const admittedP = backup(); // claims the flag synchronously, then parks in the hook
    await Promise.resolve(); // let the admitted call reach the hook's await
    expect(hookFired).toBe(true);

    // Second caller enters now, with the flag held by the parked admitted call: must skip.
    const second = await dbSnapshot();
    expect(second.ran).toBe(false);
    expect(second.detail).toMatch(/in flight/i);

    release(); // unpark the admitted call; offline it stops at the unconfigured check
    const admitted = await admittedP;
    expect(admitted.ran).toBe(false);
    expect(admitted.detail).toMatch(/not configured/i);
  });
});

describe("BACKUP_CRON scheduling", () => {
  test("the default expression is a valid cron", () => {
    expect(config.backupCron).toBe("*/15 * * * *");
    const c = new Cron(config.backupCron, { paused: true });
    expect(c.nextRun()).toBeInstanceOf(Date);
    c.stop();
  });
});

describe("snapshot manifest admission", () => {
  const fixtureDump = [
    "COPY public.schema_migrations (name) FROM stdin;",
    "020.sql",
    "\\.",
    "COPY public.tasks (id) FROM stdin;",
    "1",
    "\\.",
    "COPY public.people (id) FROM stdin;",
    "1",
    "\\.",
    "COPY public.journal_entries (id) FROM stdin;",
    "1",
    "\\.",
    "COPY public.chunks (id) FROM stdin;",
    "1",
    "\\.",
    "COPY public.events (id) FROM stdin;",
    "1",
    "\\.",
    "",
  ].join("\n");

  test("publishes the manifest before restic and keeps it private", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "minime-backup-manifest-")));
    chmodSync(root, 0o700);
    __setDumpDirForTest(root);
    config.resticRepository = "test:repo";
    config.resticPasswordFile = "/test/pass";
    const trace: string[] = [];
    __setCommandRunnerForTest(async (cmd) => {
      if (cmd[0] === "pg_dump") {
        for (const option of ["--no-comments"]) {
          expect(cmd).toContain(option);
        }
        const output = cmd[cmd.indexOf("-f") + 1];
        writeFileSync(output!, fixtureDump, { mode: 0o600 });
      }
      if (cmd[0] === "restic" && cmd[1] === "backup") {
        const manifest = join(root, "minime.manifest.json");
        trace.push(
          `${statSync(manifest).mode & 0o777}:${JSON.parse(readFileSync(manifest, "utf8")).counts.events}`,
        );
      }
      return { ok: true };
    });
    const result = await dbSnapshot();
    expect(result.ran).toBe(true);
    expect(trace).toEqual(["384:1"]);
  });

  test("fails closed before invoking restic when manifest generation fails", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "minime-backup-manifest-")));
    chmodSync(root, 0o700);
    __setDumpDirForTest(root);
    config.resticRepository = "test:repo";
    config.resticPasswordFile = "/test/pass";
    __setManifestWriterForTest(async () => {
      throw new Error("private fixture detail");
    });
    const resticCalls: string[][] = [];
    __setCommandRunnerForTest(async (cmd) => {
      if (cmd[0] === "restic") resticCalls.push(cmd);
      if (cmd[0] === "pg_dump") {
        const output = cmd[cmd.indexOf("-f") + 1];
        writeFileSync(output!, fixtureDump, { mode: 0o600 });
      }
      return { ok: true };
    });
    const result = await dbSnapshot();
    expect(result).toEqual({ ran: false, detail: "backup failed (snapshot_manifest)" });
    expect(resticCalls).toEqual([]);
  });

  test("preserves the prior verified pair when replacement manifest publication fails", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "minime-backup-manifest-")));
    chmodSync(root, 0o700);
    __setDumpDirForTest(root);
    config.resticRepository = "test:repo";
    config.resticPasswordFile = "/test/pass";
    const stableDump = join(root, "minime.sql");
    writeFileSync(stableDump, fixtureDump, { mode: 0o600 });
    await publishSnapshotManifest(root, stableDump);
    const replacement = fixtureDump.replace(
      "COPY public.tasks (id) FROM stdin;\n1\n\\.",
      "COPY public.tasks (id) FROM stdin;\n1\n2\n\\.",
    );
    __setManifestWriterForTest(async () => {
      throw new Error("fictional manifest interruption");
    });
    __setCommandRunnerForTest(async (cmd) => {
      if (cmd[0] === "pg_dump") {
        const output = cmd[cmd.indexOf("-f") + 1];
        writeFileSync(output!, replacement, { mode: 0o600 });
      }
      return { ok: true };
    });

    await expect(dbSnapshot()).resolves.toEqual({
      ran: false,
      detail: "backup failed (snapshot_manifest)",
    });
    const previousDump = readFileSync(join(root, PREVIOUS_SNAPSHOT_DUMP_BASENAME), "utf8");
    const previousManifest = await readSnapshotManifest(
      join(root, PREVIOUS_SNAPSHOT_MANIFEST_BASENAME),
    );
    expect(previousDump).toBe(fixtureDump);
    expect(buildSnapshotManifest(previousDump)).toEqual(previousManifest);
    expect(statSync(join(root, PREVIOUS_SNAPSHOT_DUMP_BASENAME)).mode & 0o777).toBe(0o600);
    expect(statSync(join(root, PREVIOUS_SNAPSHOT_MANIFEST_BASENAME)).mode & 0o777).toBe(0o600);
    expect(readFileSync(stableDump, "utf8")).toBe(replacement);
  });
});
