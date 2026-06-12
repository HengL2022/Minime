// SessionEnd hook e2e (DECISIONS.md 2026-06-12): the hook script turns a transcript JSONL
// into a markdown inbox capture (no model call, idempotent, trivial sessions skipped), and
// the existing watcher pipeline files it as a note → brain page. Fixture session is fictional.

import { beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "../src/util/config";
import { resetDb, testSql as sql } from "./helpers";

const REPO = join(import.meta.dir, "..");
const SCRIPT = join(REPO, "agents", "hooks", "session-capture.sh");
const TRANSCRIPT = join(REPO, "fixtures", "session-transcript.jsonl");
const SESSION_ID = "a1b2c3d4-0000-4000-8000-feedfacecafe";

function runHook(hookJson: object): string {
  const proc = Bun.spawnSync(["bash", SCRIPT], {
    stdin: Buffer.from(JSON.stringify(hookJson)),
    env: { ...process.env, MINIME_DATA_DIR: config.dataDir },
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
    const [item] = await sql`select filed_table, filed_id from inbox_items where id = ${inboxId}`;
    expect(item!.filed_table).toBe("pages");
    const [page] = await sql`select title, source, derived_from from pages
                             where id = ${item!.filed_id}`;
    expect(page!.source).toBe("capture");
    expect(page!.derived_from).toBe(inboxId);
    expect(page!.title).toContain("Agent session");
  });
});
