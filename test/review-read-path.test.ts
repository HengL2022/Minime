// W2-2: minime_review_queue's enriched inbox_unfiled/duplicate payloads, and the owner-only
// `minime review` CLI listing that needs no tier-2 unlock. classify.ts treats a not-yet-filed
// capture as tier-2-equivalent, so the classifier's type/confidence GUESS is metadata and always
// visible, while the free-text reason and a capture-text excerpt stay behind the same tier-2
// unlock as journal/interaction content until the owner approves one (DECISIONS.md 2026-08-08).

import { beforeAll, describe, expect, test } from "bun:test";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { reviewQueueSummaries } from "../src/cli";
import { retractRow } from "../src/db/repo";
import { toolByName } from "../src/mcp/tools";
import { invokeTool } from "../src/mcp/tools/registry";
import { processInboxFile } from "../src/pipeline/watcher";
import { config } from "../src/util/config";
import { resetDb, testSql } from "./helpers";
import { requestAndApproveTier2, sessionToolCtx } from "./support/unlock";

const HIDDEN = "[above current tier]";
const RETRACTED = "[retracted]";
const inboxDir = join(config.dataDir, "inbox");

beforeAll(async () => {
  await resetDb();
  await mkdir(inboxDir, { recursive: true });
});

async function listInboxUnfiled(ctx: ReturnType<typeof sessionToolCtx>) {
  const result = await invokeTool(
    toolByName("minime_review_queue"),
    { action: "list", kind: "inbox_unfiled" },
    ctx,
  );
  if (!result.ok) throw new Error(result.error.message);
  return result;
}

describe("minime_review_queue: enriched inbox_unfiled/duplicate read path", () => {
  test("tier-1 session sees the classifier guess but reason/text stay masked, with a gap", async () => {
    const text = "unclear: ZQX-REVIEW-READ-PATH-LOCKED fictional note about the tidepool gauge";
    const path = join(inboxDir, "zqx-review-read-path-locked.md");
    await Bun.write(path, text);
    const { inboxId, filed } = await processInboxFile(path);
    expect(filed).toBe(false); // low-confidence "unknown" -> unfiled, not guessed into a table

    const result = await listInboxUnfiled(sessionToolCtx("agent:review-read-path-locked"));
    const item = (result.envelope.data as any).items.find(
      (i: any) => i.payload?.inbox_item_id === inboxId,
    );
    expect(item).toBeTruthy();
    expect(item.payload.capture).toEqual({
      type: "unknown",
      confidence: 0.3,
      reason: HIDDEN,
      text: HIDDEN,
    });
    expect(JSON.stringify(result)).not.toContain("ZQX-REVIEW-READ-PATH-LOCKED");
    expect(result.envelope.gaps?.some((g) => g.includes("tier 2"))).toBe(true);
  });

  test("an approved tier-2 unlock reveals the reason and a text excerpt matching the archive", async () => {
    const text = "unclear: ZQX-REVIEW-READ-PATH-UNLOCKED fictional note about the drift correction";
    const path = join(inboxDir, "zqx-review-read-path-unlocked.md");
    await Bun.write(path, text);
    const { inboxId, filed } = await processInboxFile(path);
    expect(filed).toBe(false);

    const ctx = sessionToolCtx("agent:review-read-path-unlocked");
    await requestAndApproveTier2(ctx);
    const result = await listInboxUnfiled(ctx);
    const item = (result.envelope.data as any).items.find(
      (i: any) => i.payload?.inbox_item_id === inboxId,
    );
    expect(item.payload.capture.type).toBe("unknown");
    expect(item.payload.capture.confidence).toBe(0.3);
    expect(item.payload.capture.reason).toBe("explicitly marked unclear");
    expect(item.payload.capture.text).toBe(text);

    const [row] = await testSql`select archive_path from inbox_items where id = ${inboxId}::uuid`;
    const archived = await readFile(join(config.dataDir, String(row!.archive_path)), "utf8");
    expect(item.payload.capture.text).toBe(archived);
  });

  test("raw_path and classifier_output never appear at any tier", async () => {
    const path = join(inboxDir, "zqx-review-read-path-secret.md");
    await Bun.write(path, "unclear: ZQX-REVIEW-READ-PATH-SECRET fictional note about the buoy");
    await processInboxFile(path);

    const locked = await listInboxUnfiled(sessionToolCtx("agent:review-read-path-secrecy-locked"));
    const unlockedCtx = sessionToolCtx("agent:review-read-path-secrecy-unlocked");
    await requestAndApproveTier2(unlockedCtx);
    const unlocked = await listInboxUnfiled(unlockedCtx);

    const combined = JSON.stringify({ locked, unlocked });
    expect(combined).not.toContain(path);
    expect(combined).not.toContain(config.dataDir);
    expect(combined).not.toContain("classifier_output");
    expect(combined).not.toContain("raw_path");
  });

  test("duplicate-kind capture follows the same tier gate as inbox_unfiled", async () => {
    const [existing] = await testSql`
      insert into tasks (title, status, tier)
      values ('ZQX-REVIEW-READ-PATH-DUP fictional calibration run', 'active', 1)
      returning id`;
    const text = "todo: ZQX-REVIEW-READ-PATH-DUP fictional calibration run";
    const path = join(inboxDir, "zqx-review-read-path-dup.md");
    await Bun.write(path, text);
    const { inboxId, filed } = await processInboxFile(path);
    expect(filed).toBe(false); // routed to review as a likely duplicate, not filed

    const lockedResult = await invokeTool(
      toolByName("minime_review_queue"),
      { action: "list", kind: "duplicate" },
      sessionToolCtx("agent:review-read-path-dup-locked"),
    );
    if (!lockedResult.ok) throw new Error(lockedResult.error.message);
    const lockedItem = (lockedResult.envelope.data as any).items.find(
      (i: any) => i.payload?.inbox_item_id === inboxId,
    );
    expect(lockedItem.payload.existing_task_id).toBe(existing!.id);
    expect(lockedItem.payload.capture.type).toBe("task");
    expect(lockedItem.payload.capture.confidence).toBe(0.9);
    expect(lockedItem.payload.capture.text).toBe(HIDDEN);

    const unlockCtx = sessionToolCtx("agent:review-read-path-dup-unlocked");
    await requestAndApproveTier2(unlockCtx);
    const unlockedResult = await invokeTool(
      toolByName("minime_review_queue"),
      { action: "list", kind: "duplicate" },
      unlockCtx,
    );
    if (!unlockedResult.ok) throw new Error(unlockedResult.error.message);
    const unlockedItem = (unlockedResult.envelope.data as any).items.find(
      (i: any) => i.payload?.inbox_item_id === inboxId,
    );
    expect(unlockedItem.payload.capture.text).toBe(text);
  });

  // W2-5 regression: parentMeta (repo.ts) now excludes retracted rows for every caller, not just
  // hybridSearch. Before that change, a parentMeta miss for existing_title could only mean
  // "above current tier". A retracted-but-tier-1 target must not ride that same false claim —
  // it would read as a tier problem and could prompt an unneeded owner tier-2-unlock approval.
  test("a retracted duplicate target reads [retracted], not the false '[above current tier]' claim", async () => {
    const [existing] = await testSql`
      insert into tasks (title, status, tier)
      values ('ZQX-REVIEW-READ-PATH-RETRACTED fictional calibration run', 'active', 1)
      returning id`;
    const text = "todo: ZQX-REVIEW-READ-PATH-RETRACTED fictional calibration run";
    const path = join(inboxDir, "zqx-review-read-path-retracted.md");
    await Bun.write(path, text);
    const { inboxId, filed } = await processInboxFile(path);
    expect(filed).toBe(false); // routed to review as a likely duplicate, not filed

    await retractRow("task", existing!.id);

    const result = await invokeTool(
      toolByName("minime_review_queue"),
      { action: "list", kind: "duplicate" },
      sessionToolCtx("agent:review-read-path-retracted"),
    );
    if (!result.ok) throw new Error(result.error.message);
    const item = (result.envelope.data as any).items.find(
      (i: any) => i.payload?.inbox_item_id === inboxId,
    );
    expect(item.payload.existing_task_id).toBe(existing!.id);
    expect(item.payload.existing_title).toBe(RETRACTED);
    expect(item.payload.existing_title).not.toBe(HIDDEN);
  });

  test("a legacy item with no matching inbox row is untouched (no crash, no capture field)", async () => {
    const { insertReviewItem } = await import("../src/db/repo");
    const { id } = await insertReviewItem("inbox_unfiled", {
      inbox_item_id: "22222222-2222-4222-8222-222222222222",
    });
    const result = await listInboxUnfiled(sessionToolCtx("agent:review-read-path-orphan"));
    const item = (result.envelope.data as any).items.find((i: any) => i.id === id);
    expect(item).toBeTruthy();
    expect(item.payload.capture).toBeUndefined();
  });
});

describe("minime review CLI: owner-only listing needs no unlock", () => {
  test("reviewQueueSummaries lists a pending inbox_unfiled item with full unmasked text", async () => {
    const text = "unclear: ZQX-CLI-REVIEW fictional note about the buoy mooring line";
    const path = join(inboxDir, "zqx-cli-review.md");
    await Bun.write(path, text);
    const { inboxId } = await processInboxFile(path);

    const summaries = await reviewQueueSummaries();
    const summary = summaries.find((s) => s.inbox_item_id === inboxId);
    expect(summary).toBeTruthy();
    expect(summary!.kind).toBe("inbox_unfiled");
    expect(summary!.type).toBe("unknown");
    expect(summary!.confidence).toBe(0.3);
    expect(summary!.reason).toBe("explicitly marked unclear");
    expect(summary!.text).toBe(text);
  });

  test("reviewQueueSummaries lists a pending duplicate item with existing-task fields", async () => {
    const [existing] = await testSql`
      insert into tasks (title, status, tier)
      values ('ZQX-CLI-REVIEW-DUP fictional mooring inspection', 'active', 1)
      returning id`;
    const text = "todo: ZQX-CLI-REVIEW-DUP fictional mooring inspection";
    const path = join(inboxDir, "zqx-cli-review-dup.md");
    await Bun.write(path, text);
    const { inboxId } = await processInboxFile(path);

    const summaries = await reviewQueueSummaries();
    const summary = summaries.find((s) => s.inbox_item_id === inboxId);
    expect(summary).toBeTruthy();
    expect(summary!.kind).toBe("duplicate");
    expect(summary!.existing_task_id).toBe(existing!.id);
    expect(summary!.text).toBe(text);
  });
});
