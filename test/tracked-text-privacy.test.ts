import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = join(import.meta.dir, "..");
const SCRIPT = join(REPO, "scripts", "check-tracked-privacy.ts");
const CLEAR_TERM = ["not", "present"].join("-");
const tempRoots: string[] = [];

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "minime-privacy-"));
  tempRoots.push(dir);
  runGit(dir, ["init", "--initial-branch=main"]);
  runGit(dir, ["config", "user.name", "Fixture Owner"]);
  runGit(dir, ["config", "user.email", "fixture@example.test"]);
  return dir;
}

function runGit(cwd: string, args: string[], extraEnv?: Record<string, string>): string {
  const result = Bun.spawnSync(["git", ...args], {
    cwd,
    env: { ...process.env, ...extraEnv },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(`fixture git failed: ${args.join(" ")}\n${result.stderr.toString()}`);
  }
  return result.stdout.toString().trim();
}

function runGitBytes(cwd: string, args: string[], input: Uint8Array): string {
  const result = Bun.spawnSync(["git", ...args], {
    cwd,
    env: { ...process.env },
    stdin: input,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(`fixture git failed: ${args.join(" ")}\n${result.stderr.toString()}`);
  }
  return result.stdout.toString().trim();
}

function commit(cwd: string, message: string, extraEnv?: Record<string, string>): string {
  runGit(cwd, ["add", "--all"]);
  runGit(cwd, ["commit", "--no-gpg-sign", "-m", message], extraEnv);
  return runGit(cwd, ["rev-parse", "HEAD"]);
}

function invoke(
  cwd: string,
  terms: Uint8Array | string,
  args: string[] = [],
  env: Record<string, string | undefined> = {},
): { code: number; stdout: string; stderr: string } {
  const result = Bun.spawnSync(["bun", "run", SCRIPT, ...args], {
    cwd,
    env: { ...process.env, ...env },
    stdin: typeof terms === "string" ? Buffer.from(terms) : terms,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: result.exitCode ?? -1,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

function assertNoSensitiveOutput(result: { stdout: string; stderr: string }, term: string): void {
  expect(`${result.stdout}${result.stderr}`).not.toContain(term);
  expect(result.stderr).toBe("");
}

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("tracked text privacy scanner", () => {
  test("detects unstaged and staged tracked changes while ignoring untracked files", () => {
    const cwd = makeRepo();
    writeFileSync(join(cwd, "tracked.txt"), "safe\n");
    writeFileSync(join(cwd, "staged.txt"), "safe\n");
    commit(cwd, "base");
    writeFileSync(join(cwd, "tracked.txt"), "unstaged-owner-secret\n");
    writeFileSync(join(cwd, "staged.txt"), "staged-owner-secret\n");
    runGit(cwd, ["add", "staged.txt"]);
    writeFileSync(join(cwd, "staged.txt"), "working-tree-safe\n");
    writeFileSync(join(cwd, "untracked.txt"), "untracked-owner-secret\n");

    const result = invoke(cwd, "owner-secret\n", ["--base", "HEAD"]);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain('scope=tree path="tracked.txt" line=1 occurrences=1');
    expect(result.stdout).toContain('scope=tree path="staged.txt" line=1 occurrences=1');
    expect(result.stdout).not.toContain("untracked.txt");
    expect(result.stdout).toContain("summary status=hits");
    assertNoSensitiveOutput(result, "owner-secret");
  });

  test("scans intermediate outgoing blobs, metadata, and messages but excludes BASE objects", () => {
    const cwd = makeRepo();
    writeFileSync(join(cwd, "base.txt"), "base-public\n");
    const base = commit(cwd, "base message");

    writeFileSync(join(cwd, "deleted.txt"), "intermediate-owner-secret\n");
    const first = commit(cwd, "intermediate commit");
    runGit(cwd, ["rm", "deleted.txt"]);
    commit(cwd, "final commit message-owner-secret", {
      GIT_AUTHOR_NAME: "Owner Secret Author",
      GIT_AUTHOR_EMAIL: "author-secret@example.test",
      GIT_COMMITTER_NAME: "Owner Secret Committer",
      GIT_COMMITTER_EMAIL: "committer-secret@example.test",
    });
    expect(first).toMatch(/^[0-9a-f]{40}$/);

    const outgoing = invoke(
      cwd,
      "intermediate-owner-secret\nauthor-secret\ncommitter-secret\nmessage-owner-secret\n",
      ["--base", base],
    );
    expect(outgoing.code).toBe(1);
    expect(outgoing.stdout).toContain("scope=outgoing_blob");
    expect(outgoing.stdout).toContain("scope=commit");
    expect(outgoing.stdout).toContain("summary status=hits");
    expect(outgoing.stdout).toContain("outgoing_blobs=1");
    expect(outgoing.stdout).toContain("outgoing_commits=2");
    assertNoSensitiveOutput(outgoing, "intermediate-owner-secret");
    assertNoSensitiveOutput(outgoing, "author-secret");
    assertNoSensitiveOutput(outgoing, "committer-secret");
    assertNoSensitiveOutput(outgoing, "message-owner-secret");

    writeFileSync(join(cwd, "base.txt"), "working-tree-safe\n");
    runGit(cwd, ["add", "base.txt"]);
    const clear = invoke(cwd, "base-public\n", ["--base", base]);
    expect(clear.code).toBe(0);
    expect(clear.stdout).toContain("summary status=clear");
    expect(clear.stdout).toContain("outgoing_blobs=1");
    expect(clear.stdout).not.toContain("scope=outgoing_blob");
    expect(clear.stdout).not.toContain("scope=commit");
    expect(clear.stdout).not.toContain(base);
  });

  test("scans duplicate blob IDs once and skips binary content", () => {
    const cwd = makeRepo();
    writeFileSync(join(cwd, "seed.txt"), "seed\n");
    const base = commit(cwd, "base");
    writeFileSync(join(cwd, "one.txt"), "duplicate-owner-secret\n");
    writeFileSync(join(cwd, "two.txt"), "duplicate-owner-secret\n");
    writeFileSync(
      join(cwd, "binary.bin"),
      Buffer.from([0x6f, 0x77, 0x6e, 0x65, 0x72, 0x00, 0x73, 0x65, 0x63]),
    );
    commit(cwd, "duplicate content");

    const result = invoke(cwd, "duplicate-owner-secret\n", ["--base", base]);
    expect(result.code).toBe(1);
    expect(result.stdout.match(/scope=outgoing_blob/g)?.length).toBe(1);
    expect(result.stdout).toContain("outgoing_blobs=2");
    expect(result.stdout).not.toContain("binary.bin");
    assertNoSensitiveOutput(result, "duplicate-owner-secret");

    const clear = invoke(cwd, "never-present\n", ["--base", base]);
    expect(clear.code).toBe(0);
  });

  test("supports stdin and inherited terms FDs, and keeps terms out of argv/env", () => {
    const cwd = makeRepo();
    writeFileSync(join(cwd, "tracked.txt"), "safe\n");
    commit(cwd, "base");
    writeFileSync(join(cwd, "tracked.txt"), "fd-owner-secret\n");

    const stdinResult = invoke(cwd, "fd-owner-secret\n", ["--base", "HEAD"]);
    expect(stdinResult.code).toBe(1);
    expect(stdinResult.stdout).toContain('scope=tree path="tracked.txt" line=1 occurrences=1');

    const termsPath = join(cwd, "terms.txt");
    writeFileSync(termsPath, "fd-owner-secret\n");
    const inherited = Bun.spawnSync(
      [
        "bash",
        "-c",
        'exec 3<"$1"; exec bun run "$2" --base HEAD --terms-fd 3',
        "_",
        termsPath,
        SCRIPT,
      ],
      {
        cwd,
        env: { ...process.env, PRIVACY_TERMS: "fd-owner-secret" },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(inherited.exitCode).toBe(1);
    expect(inherited.stdout.toString()).toContain("scope=tree");
    expect(inherited.stderr.toString()).toBe("");

    const envOnly = invoke(cwd, `${CLEAR_TERM}\n`, ["--base", "HEAD"], {
      PRIVACY_TERMS: "fd-owner-secret",
    });
    expect(envOnly.code).toBe(0);
    expect(envOnly.stdout).toContain("summary status=clear");
    assertNoSensitiveOutput(envOnly, "fd-owner-secret");

    const argv = invoke(cwd, "safe\n", ["--base", "HEAD", "--term", "fd-owner-secret"]);
    expect(argv.code).toBe(2);
    expect(argv.stdout).toBe("PRIVACY_SCAN error code=usage\n");
    assertNoSensitiveOutput(argv, "fd-owner-secret");
  });

  test("escapes hostile filenames and only reports location/count fields", () => {
    const cwd = makeRepo();
    const hostile = "hostile \n\t name.txt";
    writeFileSync(join(cwd, hostile), "hostile-owner-secret hostile-owner-secret\n");
    commit(cwd, "base");
    writeFileSync(join(cwd, hostile), "hostile-owner-secret hostile-owner-secret\n");

    const result = invoke(cwd, "hostile-owner-secret\n", ["--base", "HEAD"]);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain('path="hostile \\n\\t name.txt" line=1 occurrences=2');
    expect(result.stdout).not.toContain("hostile-owner-secret");
    expect(result.stdout).toMatch(/^PRIVACY_SCAN (match|summary) .*$/m);
    expect(result.stderr).toBe("");
  });

  test("returns sanitized fixed errors and demonstrates clear/hit/usage exit codes", () => {
    const cwd = makeRepo();
    writeFileSync(join(cwd, "tracked.txt"), "safe\n");
    commit(cwd, "base");
    const badRef = invoke(cwd, "safe\n", ["--base", "not-a-real-ref"]);
    expect(badRef.code).toBe(2);
    expect(badRef.stdout).toBe("PRIVACY_SCAN error code=invalid_base\n");
    assertNoSensitiveOutput(badRef, "safe");

    const malformed = invoke(cwd, new Uint8Array([0xff, 0xfe]), ["--base", "HEAD"]);
    expect(malformed.code).toBe(2);
    expect(malformed.stdout).toBe("PRIVACY_SCAN error code=malformed_terms\n");
    expect(malformed.stderr).toBe("");

    const empty = invoke(cwd, "\n", ["--base", "HEAD"]);
    expect(empty.code).toBe(2);
    expect(empty.stdout).toBe("PRIVACY_SCAN error code=malformed_terms\n");

    const nul = invoke(cwd, new Uint8Array([0x73, 0x00, 0x65]), ["--base", "HEAD"]);
    expect(nul.code).toBe(2);
    expect(nul.stdout).toBe("PRIVACY_SCAN error code=malformed_terms\n");

    const unknown = invoke(cwd, "safe\n", ["--base", "HEAD", "--terms-fd", "not-a-fd"]);
    expect(unknown.code).toBe(2);
    expect(unknown.stdout).toBe("PRIVACY_SCAN error code=usage\n");

    const nonRepo = mkdtempSync(join(tmpdir(), "minime-privacy-nonrepo-"));
    tempRoots.push(nonRepo);
    const nonRepoResult = invoke(nonRepo, "safe\n", ["--base", "HEAD"]);
    expect(nonRepoResult.code).toBe(2);
    expect(nonRepoResult.stdout).toBe("PRIVACY_SCAN error code=non_repo\n");

    const nonAncestor = makeRepo();
    writeFileSync(join(nonAncestor, "one.txt"), "one\n");
    const first = commit(nonAncestor, "first");
    writeFileSync(join(nonAncestor, "two.txt"), "two\n");
    const second = commit(nonAncestor, "second");
    runGit(nonAncestor, ["checkout", "--detach", first]);
    const ancestry = invoke(nonAncestor, "safe\n", ["--base", second]);
    expect(ancestry.code).toBe(2);
    expect(ancestry.stdout).toBe("PRIVACY_SCAN error code=non_ancestor\n");

    const clear = invoke(cwd, `${["owner", CLEAR_TERM].join("-")}\n`, ["--base", "HEAD"]);
    expect(clear.code).toBe(0);
    expect(clear.stdout).toContain("summary status=clear");
  });

  test("redacts terms that occur in tracked and outgoing filenames", () => {
    const cwd = makeRepo();
    writeFileSync(join(cwd, "base.txt"), "safe\n");
    const base = commit(cwd, "base");
    const filename = "private-secret.txt";
    writeFileSync(join(cwd, filename), "private-secret\n");
    commit(cwd, "filename term");

    const result = invoke(cwd, "private-secret\n", ["--base", base]);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("scope=tree");
    expect(result.stdout).toContain("scope=outgoing_blob");
    expect(result.stdout).not.toContain("private-secret");
    expect(result.stdout).toContain("path=");
  });

  test("scans every unmerged index stage, including a non-working-tree secret", () => {
    const cwd = makeRepo();
    writeFileSync(join(cwd, "conflict.txt"), "base\n");
    const base = commit(cwd, "base");
    runGit(cwd, ["checkout", "-b", "feature"]);
    writeFileSync(join(cwd, "conflict.txt"), "feature-only-secret\n");
    commit(cwd, "feature");
    runGit(cwd, ["checkout", "main"]);
    writeFileSync(join(cwd, "conflict.txt"), "main-safe\n");
    commit(cwd, "main");
    const merge = Bun.spawnSync(["git", "merge", "feature"], {
      cwd,
      env: { ...process.env },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(merge.exitCode).not.toBe(0);
    writeFileSync(join(cwd, "conflict.txt"), "working-tree-safe\n");

    const result = invoke(cwd, "feature-only-secret\n", ["--base", base]);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain('scope=tree path="conflict.txt"');
    expect(result.stdout).not.toContain("scope=outgoing_blob");
    expect(result.stdout).not.toContain("scope=commit");
    assertNoSensitiveOutput(result, "feature-only-secret");
  });

  test("does not follow symlinked parents but scans a final tracked symlink payload", () => {
    const cwd = makeRepo();
    mkdirSync(join(cwd, "nested"), { recursive: true });
    writeFileSync(join(cwd, "nested", "file.txt"), "safe\n");
    symlinkSync("safe-target", join(cwd, "final-link"));
    const base = commit(cwd, "base");

    const external = mkdtempSync(join(tmpdir(), "minime-privacy-external-"));
    tempRoots.push(external);
    writeFileSync(join(external, "file.txt"), "external-secret\n");
    rmSync(join(cwd, "nested"), { recursive: true, force: true });
    symlinkSync(external, join(cwd, "nested"));
    rmSync(join(cwd, "final-link"), { force: true });
    symlinkSync("final-link-secret", join(cwd, "final-link"));

    const result = invoke(cwd, "external-secret\nfinal-link-secret\n", ["--base", base]);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain('scope=tree path="final-link"');
    expect(result.stdout).not.toContain("nested/file.txt");
    expect(result.stdout).not.toContain("external-secret");
    assertNoSensitiveOutput(result, "external-secret");
  });

  test("scans valid commit headers even when the body is malformed", () => {
    const cwd = makeRepo();
    writeFileSync(join(cwd, "tracked.txt"), "safe\n");
    const base = commit(cwd, "base");
    const tree = runGit(cwd, ["rev-parse", "HEAD^{tree}"]);
    const raw = Buffer.from(
      `tree ${tree}\nparent ${base}\nauthor Metadata Secret <metadata-secret@example.test> 0 +0000\ncommitter Metadata Secret <metadata-secret@example.test> 0 +0000\nx-private-header metadata-only-secret\nencoding UTF-8\n\nraw-body-secret\0\xff`,
    );
    const oid = runGitBytes(
      cwd,
      ["hash-object", "--literally", "-t", "commit", "-w", "--stdin"],
      raw,
    );
    runGit(cwd, ["update-ref", "refs/heads/main", oid]);

    const result = invoke(cwd, "metadata-secret\nmetadata-only-secret\nraw-body-secret\n", [
      "--base",
      base,
    ]);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("scope=commit");
    expect(result.stdout).toContain("occurrences=1");
    expect(result.stdout).not.toContain("raw-body-secret");
    assertNoSensitiveOutput(result, "metadata-secret");

    const genericHeader = invoke(cwd, "metadata-only-secret\n", ["--base", base]);
    expect(genericHeader.code).toBe(1);
    expect(genericHeader.stdout).toContain("scope=commit");
    assertNoSensitiveOutput(genericHeader, "metadata-only-secret");
  });

  test("does not forward Git/config/trace environment or execute local fsmonitor", () => {
    const cwd = makeRepo();
    writeFileSync(join(cwd, "tracked.txt"), "safe\n");
    commit(cwd, "base");
    const marker = join(cwd, "fsmonitor-marker");
    const hook = join(cwd, "fsmonitor-hook.sh");
    writeFileSync(hook, `#!/bin/sh\nprintf '%s' "${"$PRIVACY_SECRET_ENV"}" > "${marker}"\n`);
    chmodSync(hook, 0o755);
    runGit(cwd, ["config", "core.fsmonitor", hook]);
    const trace = join(cwd, "trace-marker");
    const trace2 = join(cwd, "trace2-marker");
    const traceEvent = join(cwd, "trace-event-marker");

    const result = invoke(cwd, `${CLEAR_TERM}\n`, ["--base", "HEAD"], {
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.fsmonitor",
      GIT_CONFIG_VALUE_0: hook,
      GIT_TRACE: trace,
      GIT_TRACE2: trace2,
      GIT_TRACE2_EVENT: traceEvent,
      PRIVACY_SECRET_ENV: "forwarded-secret",
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("summary status=clear");
    expect(result.stderr).toBe("");
    expect(() => readFileSync(marker)).toThrow();
    expect(() => readFileSync(trace)).toThrow();
    expect(() => readFileSync(trace2)).toThrow();
    expect(() => readFileSync(traceEvent)).toThrow();
  });

  test("classifies hostile Git failures as sanitized internal errors", () => {
    const cwd = makeRepo();
    writeFileSync(join(cwd, "tracked.txt"), "safe\n");
    commit(cwd, "base");
    const fakeDir = mkdtempSync(join(tmpdir(), "minime-privacy-fake-git-"));
    tempRoots.push(fakeDir);
    const fakeGit = join(fakeDir, "git");
    writeFileSync(fakeGit, "#!/bin/sh\nprintf '%s\\n' hostile-git-stderr >&2\nexit 77\n");
    chmodSync(fakeGit, 0o755);
    const result = invoke(cwd, "safe\n", ["--base", "HEAD"], {
      PATH: `${fakeDir}:${process.env.PATH ?? ""}`,
    });
    expect(result.code).toBe(3);
    expect(result.stdout).toBe("PRIVACY_SCAN error code=git\n");
    expect(result.stderr).toBe("");
    expect(result.stdout).not.toContain("hostile-git-stderr");
  });

  test("classifies unexpected BASE Git failures separately from a missing ref", () => {
    const cwd = makeRepo();
    writeFileSync(join(cwd, "tracked.txt"), "safe\n");
    commit(cwd, "base");
    const fakeDir = mkdtempSync(join(tmpdir(), "minime-privacy-selective-git-"));
    tempRoots.push(fakeDir);
    const fakeGit = join(fakeDir, "git");
    const realGit = Bun.spawnSync(["which", "git"], { stdout: "pipe", stderr: "pipe" })
      .stdout.toString()
      .trim();
    writeFileSync(
      fakeGit,
      `#!/bin/sh
for arg in "$@"; do
  if [ "$arg" = "trigger-private-ref^{commit}" ]; then
    printf '%s\\n' hostile-base-git-stderr >&2
    exit 77
  fi
done
exec "${realGit}" "$@"
`,
    );
    chmodSync(fakeGit, 0o755);

    const result = invoke(cwd, "safe\n", ["--base", "trigger-private-ref"], {
      PATH: `${fakeDir}:${process.env.PATH ?? ""}`,
    });
    expect(result.code).toBe(3);
    expect(result.stdout).toBe("PRIVACY_SCAN error code=git\n");
    expect(result.stderr).toBe("");
    expect(result.stdout).not.toContain("hostile-base-git-stderr");

    const missing = invoke(cwd, "safe\n", ["--base", "genuinely-missing-ref"]);
    expect(missing.code).toBe(2);
    expect(missing.stdout).toBe("PRIVACY_SCAN error code=invalid_base\n");
    expect(missing.stderr).toBe("");
  });

  test("keeps Make output allowlisted and treats hostile BASE as data", () => {
    const normal = Bun.spawnSync(
      ["make", "--no-print-directory", "check-tracked-privacy", "BASE=HEAD"],
      {
        cwd: REPO,
        stdin: Buffer.from(`${CLEAR_TERM}\n`),
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(normal.exitCode).toBe(0);
    expect(normal.stdout.toString()).toContain("PRIVACY_SCAN summary status=clear");
    expect(normal.stderr.toString()).toBe("");

    const missing = Bun.spawnSync(["make", "--no-print-directory", "check-tracked-privacy"], {
      cwd: REPO,
      stdin: Buffer.from(`${CLEAR_TERM}\n`),
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(missing.exitCode).toBe(2);
    expect(missing.stdout.toString()).toBe("PRIVACY_SCAN error code=usage\n");
    expect(missing.stderr.toString()).toMatch(
      /\*\*\* \[(?:Makefile:\d+: )?check-tracked-privacy\] Error 2/,
    );
    expect(missing.stderr.toString()).not.toContain("usage:");

    const makeDir = mkdtempSync(join(tmpdir(), "minime-privacy-make-"));
    tempRoots.push(makeDir);
    const marker = join(makeDir, "marker");
    const hostile = `HEAD; touch ${marker}`;
    const injected = Bun.spawnSync(
      ["make", "--no-print-directory", "check-tracked-privacy", `BASE=${hostile}`],
      {
        cwd: REPO,
        stdin: Buffer.from(`${CLEAR_TERM}\n`),
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(injected.exitCode).toBe(2);
    expect(injected.stdout.toString()).toBe("PRIVACY_SCAN error code=invalid_base\n");
    expect(injected.stderr.toString()).toMatch(
      /\*\*\* \[(?:Makefile:\d+: )?check-tracked-privacy\] Error 2/,
    );
    expect(injected.stderr.toString()).not.toContain(marker);
    expect(() => readFileSync(marker)).toThrow();

    const shellMarker = join(makeDir, "shell-marker");
    const shellExpansion = Bun.spawnSync(
      [
        "make",
        "--no-print-directory",
        "check-tracked-privacy",
        `BASE=$(shell touch ${shellMarker})HEAD`,
      ],
      {
        cwd: REPO,
        stdin: Buffer.from(`${CLEAR_TERM}\n`),
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(shellExpansion.exitCode).toBe(2);
    expect(() => readFileSync(shellMarker)).toThrow();

    const fileMarker = join(makeDir, "file-marker");
    const fileExpansion = Bun.spawnSync(
      ["make", "--no-print-directory", "check-tracked-privacy", `BASE=$(file >${fileMarker})HEAD`],
      {
        cwd: REPO,
        stdin: Buffer.from(`${CLEAR_TERM}\n`),
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(fileExpansion.exitCode).toBe(2);
    expect(() => readFileSync(fileMarker)).toThrow();
  });
});
