// W3-8: sanitized local ops log (data/logs/ops.log). DECISIONS.md's amendment to the
// 2026-07-23 H3 content-free-diagnostics contract: audit events and console/CLI output stay
// exactly as content-free as H3 required; this owner-only mode-0600 file is the one narrow,
// allowlist-only exception. Every test here either locks down that boundary directly
// (classifyStderrLine, file placement/permissions, rotation) or proves it holds end to end
// through dream.ts's runDreamStep and backup.ts's real command-failure path, including
// against adversarial stderr crafted to look like a secret or a private path.
import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  OPS_LOG_BASENAME,
  OPS_LOG_ROTATED_BASENAME,
  appendOpsLine,
  classifyStderrLine,
} from "../src/ops/ops-log";
import {
  __setCommandRunnerForTest,
  __setDumpDirForTest,
  __setInFlightForTest,
  __setManifestWriterForTest,
  __setStatfsForTest,
  dbSnapshot,
} from "../src/pipeline/backup";
import { runDreamStep } from "../src/pipeline/dream";
import { config } from "../src/util/config";

const originalDataDir = config.dataDir;

function freshDataDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "minime-ops-log-test-")));
  config.dataDir = dir;
  return dir;
}

function opsLogPath(): string {
  return join(config.dataDir, "logs", OPS_LOG_BASENAME);
}

afterEach(() => {
  config.dataDir = originalDataDir;
  config.resticRepository = undefined;
  config.resticPasswordFile = undefined;
  __setCommandRunnerForTest(undefined);
  __setDumpDirForTest(undefined);
  __setManifestWriterForTest(undefined);
  __setStatfsForTest(undefined);
  __setInFlightForTest(false);
});

describe("classifyStderrLine (fixed allowlist)", () => {
  test("maps each documented restic/pg_dump signature to its fixed class", () => {
    expect(
      classifyStderrLine(
        "unable to create lock in backend: repository is already locked exclusively by PID 51021",
      ),
    ).toBe("repo_locked");
    expect(classifyStderrLine("Fatal: no space left on device")).toBe("disk_full");
    expect(
      classifyStderrLine(
        "Fatal: unable to open config file: Stat: the specified key does not exist",
      ),
    ).toBe("repo_auth");
    expect(classifyStderrLine("Fatal: wrong password or no key found")).toBe("repo_auth");
    expect(
      classifyStderrLine("pg_dump: error: connection to server at ... failed: Connection refused"),
    ).toBe("pg_unreachable");
  });

  test("an unmatched or empty line always classifies to unclassified", () => {
    expect(classifyStderrLine("")).toBe("unclassified");
    expect(classifyStderrLine("some completely unrelated diagnostic")).toBe("unclassified");
  });

  test("adversarial: a fake secret/path never matches the allowlist, and is never itself returned", () => {
    const sentinel = "sk-FAKE-secret-9182 leaked at /home/fictional-owner/private/wills/2026.pdf";
    const result = classifyStderrLine(sentinel);
    expect(result).toBe("unclassified");
    expect(result).not.toContain(sentinel);
    expect(result).not.toContain("/home/fictional-owner/private");
  });
});

describe("appendOpsLine (file placement, permissions, format)", () => {
  test("creates data/logs 0700 and ops.log 0600 on the first write", async () => {
    const dir = freshDataDir();
    await appendOpsLine({ step: "fixture_step", errorClass: "FixtureError" });

    const logsDir = join(dir, "logs");
    expect(statMode(logsDir)).toBe(0o700);
    expect(statMode(opsLogPath())).toBe(0o600);

    const content = readFileSync(opsLogPath(), "utf8");
    expect(content).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z fixture_step class=FixtureError\n$/,
    );
  });

  test("renders an exit code when supplied, and omits it when not", async () => {
    freshDataDir();
    await appendOpsLine({ step: "restic_backup", code: 1, detail: "repo_locked" });
    await appendOpsLine({ step: "3_contradictions", errorClass: "TypeError" });

    const lines = readFileSync(opsLogPath(), "utf8").trim().split("\n");
    expect(lines[0]).toContain("restic_backup exit=1 class=repo_locked");
    expect(lines[1]).toContain("3_contradictions class=TypeError");
    expect(lines[1]).not.toContain("exit=");
  });

  test("appends without truncating prior lines", async () => {
    freshDataDir();
    await appendOpsLine({ step: "a", errorClass: "First" });
    await appendOpsLine({ step: "b", errorClass: "Second" });

    const lines = readFileSync(opsLogPath(), "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("a class=First");
    expect(lines[1]).toContain("b class=Second");
  });

  test("rotates the current file to ops.log.1 once it is at/over the size threshold", async () => {
    const dir = freshDataDir();
    const logsDir = join(dir, "logs");
    mkdirSync(logsDir, { mode: 0o700 });
    const oldContent = "x".repeat(1_000_000);
    writeFileSync(opsLogPath(), oldContent, { mode: 0o600 });

    await appendOpsLine({ step: "after_rotation", errorClass: "Boom" });

    expect(readFileSync(join(logsDir, OPS_LOG_ROTATED_BASENAME), "utf8")).toBe(oldContent);
    const fresh = readFileSync(opsLogPath(), "utf8");
    expect(fresh).toContain("after_rotation class=Boom");
    expect(fresh.length).toBeLessThan(200);
  });
});

describe("dream step failures (runDreamStep)", () => {
  class FixtureBoomError extends Error {}

  test("logs the step name and error constructor name only -- never error.message", async () => {
    freshDataDir();
    const summary: Record<string, unknown> = {};

    await runDreamStep(summary, "fixture_step_boom", async () => {
      throw new FixtureBoomError("should never leak this private prose");
    });

    expect(summary.fixture_step_boom).toBe("failed"); // unchanged existing behavior

    const content = readFileSync(opsLogPath(), "utf8");
    expect(content).toContain("fixture_step_boom");
    expect(content).toContain("class=FixtureBoomError");
    expect(content).not.toContain("should never leak this private prose");
  });

  test("a successful step writes nothing to the ops log", async () => {
    freshDataDir();
    const summary: Record<string, unknown> = {};
    await runDreamStep(summary, "fixture_step_ok", async () => 42);
    expect(summary.fixture_step_ok).toBe(42);
    expect(() => readFileSync(opsLogPath(), "utf8")).toThrow(); // never created
  });
});

describe("backup command failures (backup.ts + ops-log integration)", () => {
  function configureRestic(): void {
    config.resticRepository = "test:repo";
    config.resticPasswordFile = "/test/pass";
  }

  function isolatedDumpDir(): void {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "minime-ops-log-dump-")));
    chmodSync(dir, 0o700);
    __setDumpDirForTest(dir);
  }

  function writeFixtureDump(cmd: string[]): void {
    writeFileSync(cmd[cmd.indexOf("-f") + 1]!, "-- fixture dump --\n", { mode: 0o600 });
  }

  test("acceptance: a simulated restic lock failure suffixes the returned detail, logs a " +
    "sanitized ops.log line, and leaks none of the child's raw stderr", async () => {
    freshDataDir();
    configureRestic();
    isolatedDumpDir();
    __setManifestWriterForTest(async () => {});
    const rawStderr =
      "unable to create lock in backend: repository is already locked exclusively by " +
      "PID 4242 on hostname by owner (UID 501, GID 20)\nlock was created at 2026-08-09 03:00:00\n";
    __setCommandRunnerForTest(async (cmd) => {
      if (cmd[0] === "pg_dump") {
        writeFixtureDump(cmd);
        return { ok: true };
      }
      if (cmd[0] === "restic" && cmd[1] === "backup") {
        return { ok: false, failure: "exit_nonzero", code: 1, stderrHead: rawStderr };
      }
      return { ok: true };
    });

    const result = await dbSnapshot();
    expect(result).toEqual({
      ran: false,
      detail: "backup failed (restic_backup) — see data/logs/ops.log",
    });

    const content = readFileSync(opsLogPath(), "utf8");
    expect(content).toContain("restic_backup exit=1 class=repo_locked");
    // The classification crossed; the raw child text -- PID, hostname, timestamp -- never did.
    expect(content).not.toContain("PID 4242");
    expect(content).not.toContain("hostname");
    expect(content).not.toContain("2026-08-09 03:00:00");
  });

  test("disk-headroom preflight failure writes its ops.log line and never a path (W3-9 review gap)", async () => {
    freshDataDir();
    configureRestic();
    isolatedDumpDir();
    __setManifestWriterForTest(async () => {});
    // Full disk: zero available blocks. pg_dump must never even be attempted.
    __setStatfsForTest(() => ({ bavail: 0, bsize: 4096 }));
    const commands: string[][] = [];
    __setCommandRunnerForTest(async (cmd) => {
      commands.push([...cmd]);
      return { ok: true };
    });

    const result = await dbSnapshot();
    expect(result).toEqual({
      ran: false,
      detail: "backup failed (disk_headroom) — see data/logs/ops.log",
    });
    // Version/dependency probes may run, but the actual dump (pg_dump -f …) and any restic
    // snapshot work must never start once headroom fails.
    expect(commands.some((cmd) => cmd[0] === "pg_dump" && cmd.includes("-f"))).toBe(false);
    expect(commands.some((cmd) => cmd[0] === "restic" && cmd[1] === "backup")).toBe(false);

    const content = readFileSync(opsLogPath(), "utf8");
    expect(content).toContain("disk_headroom");
    expect(content).toContain("disk_low");
    // The line carries the fixed step + class only — never the dump dir or any filesystem path.
    expect(content).not.toContain(config.dataDir);
    expect(content).not.toContain(tmpdir());
  });

  test("adversarial: a fake secret/path in child stderr never reaches ops.log (mandatory no-leak case)", async () => {
    freshDataDir();
    configureRestic();
    isolatedDumpDir();
    __setManifestWriterForTest(async () => {});
    const sentinel = "sk-FAKE-secret-9182 at /home/fictional-owner/private/wills/2026.pdf";
    __setCommandRunnerForTest(async (cmd) => {
      if (cmd[0] === "pg_dump") {
        writeFixtureDump(cmd);
        return { ok: true };
      }
      if (cmd[0] === "restic" && cmd[1] === "backup") {
        return { ok: false, failure: "exit_nonzero", code: 1, stderrHead: `${sentinel}\n` };
      }
      return { ok: true };
    });

    const result = await dbSnapshot();
    expect(result.detail).toContain("backup failed (restic_backup)");

    const content = readFileSync(opsLogPath(), "utf8");
    expect(content).toContain("restic_backup exit=1 class=unclassified");
    expect(content).not.toContain(sentinel);
    expect(content).not.toContain("sk-FAKE-secret-9182");
    expect(content).not.toContain("/home/fictional-owner/private");
  });

  test("a successful backup never writes to the ops log", async () => {
    freshDataDir();
    configureRestic();
    isolatedDumpDir();
    __setManifestWriterForTest(async () => {});
    __setCommandRunnerForTest(async (cmd) => {
      if (cmd[0] === "pg_dump") writeFixtureDump(cmd);
      return { ok: true };
    });

    const result = await dbSnapshot();
    expect(result.ran).toBe(true);
    expect(() => readFileSync(opsLogPath(), "utf8")).toThrow(); // never created
  });
});

function statMode(path: string): number {
  return statSync(path).mode & 0o777;
}
