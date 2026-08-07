// SessionEnd hook e2e (DECISIONS.md 2026-06-12): the hook script turns a transcript JSONL
// into a markdown inbox capture (no model call, idempotent, trivial sessions skipped), and
// the existing watcher pipeline files it as a note → brain page. Fixture session is fictional.

import { beforeAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { config } from "../src/util/config";
import { resetDb, testSql as sql } from "./helpers";

const REPO = join(import.meta.dir, "..");
const SCRIPT = join(REPO, "agents", "hooks", "session-capture.sh");
const TRANSCRIPT = join(REPO, "fixtures", "session-transcript.jsonl");
const SESSION_ID = "a1b2c3d4-0000-4000-8000-feedfacecafe";

function runHook(hookJson: object, dataDir = config.dataDir, cwd?: string): string {
  const proc = Bun.spawnSync(["bash", SCRIPT], {
    stdin: Buffer.from(JSON.stringify(hookJson)),
    env: { ...process.env, MINIME_DATA_DIR: dataDir },
    ...(cwd ? { cwd } : {}),
  });
  expect(proc.exitCode).toBe(0); // a capture failure must never disturb the session
  return proc.stderr.toString();
}

function inboxSessionFiles(): string[] {
  try {
    return readdirSync(join(config.dataDir, "inbox")).filter((f) => f.startsWith("session-"));
  } catch {
    return [];
  }
}

beforeAll(async () => {
  await resetDb();
});

describe("session-capture hook", () => {
  test("rejects cwd-wide and intermediate-symlink fixture roots without mutation", () => {
    const validHook = {
      session_id: "broad-root-boundary-0000",
      transcript_path: TRANSCRIPT,
      cwd: "/home/dev/harbor",
      reason: "exit",
    };
    const fixtureRoot = mkdtempSync(join(realpathSync(tmpdir()), "minime-hook-root-"));
    const outside = mkdtempSync(join(realpathSync(tmpdir()), "minime-hook-outside-"));
    try {
      chmodSync(fixtureRoot, 0o755);
      const fixtureMode = lstatSync(fixtureRoot).mode & 0o777;
      const fixtureEntries = readdirSync(fixtureRoot);
      runHook(validHook, fixtureRoot, fixtureRoot);
      expect(lstatSync(fixtureRoot).mode & 0o777).toBe(fixtureMode);
      expect(readdirSync(fixtureRoot)).toEqual(fixtureEntries);

      chmodSync(outside, 0o755);
      const linkedParent = join(fixtureRoot, "linked-parent");
      symlinkSync(outside, linkedParent, "dir");
      const beforeMode = lstatSync(outside).mode & 0o777;
      const beforeEntries = readdirSync(outside);
      runHook(validHook, join(linkedParent, "minime-data"));
      expect(lstatSync(outside).mode & 0o777).toBe(beforeMode);
      expect(readdirSync(outside)).toEqual(beforeEntries);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("resolves a relative data override from the repository under a foreign hook cwd", () => {
    const foreignCwd = mkdtempSync(join(realpathSync(tmpdir()), "minime-hook-cwd-"));
    const expected = mkdtempSync(join(realpathSync(tmpdir()), "minime-hook-relative-"));
    const relativeOverride = relative(REPO, expected);
    try {
      runHook(
        {
          session_id: "relative-root-boundary-0000",
          transcript_path: TRANSCRIPT,
          cwd: "/home/dev/harbor",
          reason: "exit",
        },
        relativeOverride,
        foreignCwd,
      );
      expect(readdirSync(join(expected, "inbox")).some((name) => name.startsWith("session-"))).toBe(
        true,
      );
      expect(existsSync(join(foreignCwd, relativeOverride))).toBe(false);
    } finally {
      rmSync(expected, { recursive: true, force: true });
      rmSync(foreignCwd, { recursive: true, force: true });
    }
  });

  test("accepts a dedicated descendant through a root-owned macOS temp alias", () => {
    const physical = mkdtempSync(join(realpathSync(tmpdir()), "minime-hook-alias-"));
    const alias = physical.startsWith("/private/var/")
      ? `/var/${physical.slice("/private/var/".length)}`
      : physical.startsWith("/private/tmp/")
        ? `/tmp/${physical.slice("/private/tmp/".length)}`
        : physical;
    try {
      runHook(
        {
          session_id: "trusted-alias-boundary-0000",
          transcript_path: TRANSCRIPT,
          cwd: "/home/dev/harbor",
          reason: "exit",
        },
        alias,
      );
      expect(readdirSync(join(physical, "inbox")).some((name) => name.startsWith("session-"))).toBe(
        true,
      );
    } finally {
      rmSync(physical, { recursive: true, force: true });
    }
  });

  test("writes a markdown capture from the transcript", async () => {
    runHook({
      session_id: SESSION_ID,
      transcript_path: TRANSCRIPT,
      cwd: "/home/dev/harbor",
      reason: "exit",
    });
    const files = inboxSessionFiles();
    expect(files.length).toBe(1);
    expect(files[0]).toContain(SESSION_ID.slice(0, 8));

    const body = await Bun.file(join(config.dataDir, "inbox", files[0]!)).text();
    expect(body).toContain("# Agent session: harbor — 2026-06-10");
    expect(body).toContain("<!-- hint: agent work session -->");
    expect(body).toContain("**Request:** Add a retry with backoff to the tide gauge importer");
    expect(body).toContain("exponential backoff and polls every 5 minutes");
    expect(body).toContain("- /home/dev/harbor/src/importers/tide-gauge.ts");
    expect(body).toContain("- /home/dev/harbor/test/tide-gauge.test.ts");
    // tool_result user message must not count as a prompt or leak into the summary
    expect(body).not.toContain("tu_1");
    const capturePath = join(config.dataDir, "inbox", files[0]!);
    expect(statSync(config.dataDir).mode & 0o777).toBe(0o700);
    expect(statSync(join(config.dataDir, "inbox")).mode & 0o777).toBe(0o700);
    expect(statSync(capturePath).mode & 0o777).toBe(0o600);
  });

  test("idempotent: a re-fired hook for the same session writes nothing", () => {
    runHook({
      session_id: SESSION_ID,
      transcript_path: TRANSCRIPT,
      cwd: "/home/dev/harbor",
      reason: "exit",
    });
    expect(inboxSessionFiles().length).toBe(1);
  });

  test("trivial session (single prompt) is skipped", () => {
    const dir = join(tmpdir(), `minime-hook-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(dir, { recursive: true });
    const t = join(dir, "trivial.jsonl");
    writeFileSync(
      t,
      `${JSON.stringify({
        type: "user",
        timestamp: "2026-06-10T10:00:00.000Z",
        message: { role: "user", content: "what time is it" },
      })}\n`,
    );
    runHook({ session_id: "ffffffff-1111", transcript_path: t, cwd: dir, reason: "exit" });
    expect(inboxSessionFiles().length).toBe(1); // still only the fixture session's capture
  });

  test("watcher files the capture as a note page with capture provenance", async () => {
    const { processInboxFile } = await import("../src/pipeline/watcher");
    const file = inboxSessionFiles()[0]!;
    const { filed, inboxId } = await processInboxFile(join(config.dataDir, "inbox", file));
    expect(filed).toBe(true);
    const [item] =
      await sql`select filed_table, filed_id, archive_path from inbox_items where id = ${inboxId}`;
    expect(item!.filed_table).toBe("pages");
    const [page] = await sql`select path, title, source, derived_from, tier from pages
                             where id = ${item!.filed_id}`;
    expect(page!.source).toBe("capture");
    expect(page!.derived_from).toBe(inboxId);
    expect(page!.title).toContain("Agent session");
    // verbatim cross-project prompt/outcome text stays behind the unlock gate (§12)
    expect(page!.tier).toBe(2);

    const notePath = join(config.dataDir, "brain", page!.path);
    expect(statSync(join(config.dataDir, "brain")).mode & 0o777).toBe(0o700);
    expect(statSync(join(config.dataDir, "brain", "inbox")).mode & 0o777).toBe(0o700);
    expect(statSync(notePath).mode & 0o777).toBe(0o600);
    expect(item!.archive_path).toContain(inboxId);
    const archivePath = join(config.dataDir, item!.archive_path);
    expect(statSync(join(config.dataDir, "archive")).mode & 0o777).toBe(0o700);
    expect(statSync(archivePath).mode & 0o777).toBe(0o600);
  });
});
