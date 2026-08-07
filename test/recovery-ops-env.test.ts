import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildRecoveryInvocation, runRecoveryOperation } from "../scripts/recovery-ops";

const REPO = resolve(import.meta.dir, "..");
const WRAPPER = resolve(REPO, "scripts/recovery-ops.ts");
const RESTORE_E2E = resolve(REPO, "scripts/verify-restic-roundtrip.ts");
const fixtures: string[] = [];

function fixtureRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "minime-recovery-ops-"));
  fixtures.push(root);
  mkdirSync(join(root, "scripts"));
  return root;
}

afterEach(() => {
  for (const fixture of fixtures.splice(0)) rmSync(fixture, { recursive: true, force: true });
});

describe("recovery operation wrapper", () => {
  test("isolated restic evidence fails closed when its real dependencies are unavailable", () => {
    const result = Bun.spawnSync([process.execPath, "--no-env-file", "run", RESTORE_E2E], {
      cwd: REPO,
      env: { PATH: "" },
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode).toBe(2);
    expect(result.stdout.toString()).toBe("");
    expect(result.stderr.toString()).toBe("restore restic round trip failed (dependencies)\n");
  });

  test("rejects every command outside the exact public grammar with a fixed diagnostic", () => {
    const result = Bun.spawnSync(
      [process.execPath, "--no-env-file", "run", WRAPPER, "unknown", "owner-secret"],
      {
        cwd: REPO,
        env: {},
        stdout: "pipe",
        stderr: "pipe",
      },
    );

    expect(result.exitCode).toBe(2);
    expect(result.stdout.toString()).toBe("");
    expect(result.stderr.toString()).toBe("recovery operation failed (usage)\n");
    expect(result.stderr.toString()).not.toContain("owner-secret");
  });

  test("loads dotenv values literally, honors caller precedence, and derives one custom-port topology", () => {
    const root = fixtureRepo();
    const sentinel = join(root, "dotenv-was-executed");
    const literal = `$(touch ${sentinel})`;
    writeFileSync(
      join(root, ".env"),
      [
        "DATABASE_URL=postgres://file:file-pass@localhost:5432/minime",
        "RESTIC_REPOSITORY=file-repository",
        "RESTIC_PASSWORD_FILE='/private/password file'",
        `B2_ACCOUNT_KEY=${literal}`,
        "AMBIENT_FILE_SECRET=must-not-reach-child",
        "BUN_INSTALL=/from/repo/dotenv/must-not-win",
      ].join("\n"),
    );

    const invocation = buildRecoveryInvocation(["drill"], {
      repoRoot: root,
      callerEnv: {
        DATABASE_URL: "postgresql://owner:p%40ss@127.0.0.1:6543/minime",
        ADMIN_URL: "postgres://attacker:secret@localhost:9999/postgres",
        RESTIC_REPOSITORY: "caller-repository",
        PGBIN: "/opt/postgresql/bin",
        BUN_INSTALL: "/caller/bun",
        TMPDIR: "/private/tmp/recovery",
        TIME: "must-not-reach-drill",
        MINIME_RESTORE_REQUIRE_RESTIC: "0",
        AMBIENT_TOKEN: "must-not-reach-child",
        PATH: "/hostile/bin",
      },
    });

    expect(invocation).toEqual({
      argv: [join(root, "scripts", "restore-drill.sh")],
      cwd: root,
      env: {
        DATABASE_URL: "postgresql://owner:p%40ss@127.0.0.1:6543/minime",
        ADMIN_URL: "postgresql://owner:p%40ss@127.0.0.1:6543/postgres",
        DRILL_URL: "postgresql://owner:p%40ss@127.0.0.1:6543/minime_drill",
        LIVE_URL: "postgresql://owner:p%40ss@127.0.0.1:6543/minime",
        RESTORE_URL: "postgresql://owner:p%40ss@127.0.0.1:6543/minime_restore",
        RESTIC_REPOSITORY: "caller-repository",
        RESTIC_PASSWORD_FILE: "/private/password file",
        B2_ACCOUNT_KEY: literal,
        PGBIN: "/opt/postgresql/bin",
        BUN_INSTALL: "/caller/bun",
        TMPDIR: "/private/tmp/recovery",
        MINIME_RESTORE_REQUIRE_RESTIC: "1",
      },
    });
    expect(existsSync(sentinel)).toBe(false);
  });

  test("maps only drill, pitr TIME, and promote to their fixed script contracts", () => {
    const root = fixtureRepo();
    writeFileSync(
      join(root, ".env"),
      "DATABASE_URL=postgres://owner:secret@localhost:6432/minime\n",
    );
    const pitr = buildRecoveryInvocation(["pitr", "2026-08-07 03:04:05 +08:00"], {
      repoRoot: root,
      callerEnv: {},
    });
    expect(pitr.argv).toEqual([join(root, "scripts", "restore-pitr.sh")]);
    expect(pitr.env.TIME).toBe("2026-08-07 03:04:05 +08:00");
    expect(pitr.env.MINIME_RESTORE_REQUIRE_RESTIC).toBeUndefined();

    const promote = buildRecoveryInvocation(["promote"], { repoRoot: root, callerEnv: {} });
    expect(promote.argv).toEqual([join(root, "scripts", "promote-restore.sh")]);
    expect(promote.env.TIME).toBeUndefined();
    expect(promote.env.MINIME_RESTORE_REQUIRE_RESTIC).toBeUndefined();

    for (const malformed of [
      [],
      ["drill", "extra"],
      ["pitr"],
      ["pitr", ""],
      ["pitr", "   "],
      ["pitr", " 2026-08-07 03:04:05"],
      ["pitr", "2026-08-07 03:04:05 "],
      ["pitr", "2026-08-07\n03:04:05"],
      ["pitr", "2026-08-07\r03:04:05"],
      ["pitr", "2026-08-07\u000003:04:05"],
      ["pitr", "2026-08-07\u001f03:04:05"],
      ["pitr", "2026-08-07\u007f03:04:05"],
      ["pitr", "2026-08-07\u008503:04:05"],
      ["pitr", "x".repeat(129)],
      ["pitr", "time", "extra"],
      ["promote", "extra"],
    ]) {
      expect(() => buildRecoveryInvocation(malformed, { repoRoot: root, callerEnv: {} })).toThrow(
        "recovery_operation_usage",
      );
    }
  });

  test("rejects invalid endpoint configuration without disclosing its input", () => {
    const secret = "endpoint-owner-secret";
    const result = Bun.spawnSync([process.execPath, "--no-env-file", "run", WRAPPER, "drill"], {
      cwd: REPO,
      env: {
        DATABASE_URL: `postgres://owner:${secret}@database.example.test:6543/minime`,
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode).toBe(1);
    expect(result.stdout.toString()).toBe("");
    expect(result.stderr.toString()).toBe("recovery operation failed (configuration)\n");
    expect(result.stderr.toString()).not.toContain(secret);
  });

  test("spawns the fixed child directly, keeps metacharacters literal, and returns its exit code", async () => {
    const root = fixtureRepo();
    const dotenvSentinel = join(root, "dotenv-sentinel");
    const timeSentinel = join(root, "time-sentinel");
    const literalRepository = `$(touch ${dotenvSentinel})`;
    const literalTime = `2026-08-07 03:04:05; $(touch ${timeSentinel})`;
    writeFileSync(
      join(root, ".env"),
      [
        "DATABASE_URL=postgres://owner:secret@localhost:6543/minime",
        `RESTIC_REPOSITORY=${literalRepository}`,
      ].join("\n"),
    );
    const child = join(root, "scripts", "restore-pitr.sh");
    writeFileSync(
      child,
      [
        "#!/bin/bash",
        "set -eu",
        `test \"$RESTIC_REPOSITORY\" = '${literalRepository}'`,
        `test \"$TIME\" = '${literalTime}'`,
        'test -z "${AMBIENT_TOKEN+x}"',
        'test "$ADMIN_URL" = "postgres://owner:secret@localhost:6543/postgres"',
        "exit 37",
      ].join("\n"),
    );
    chmodSync(child, 0o700);

    const exitCode = await runRecoveryOperation(["pitr", literalTime], {
      repoRoot: root,
      callerEnv: { AMBIENT_TOKEN: "must-not-reach-child" },
    });

    expect(exitCode).toBe(37);
    expect(existsSync(dotenvSentinel)).toBe(false);
    expect(existsSync(timeSentinel)).toBe(false);
  });
});
