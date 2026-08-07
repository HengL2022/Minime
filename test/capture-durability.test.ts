import { beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { withDbTransaction } from "../src/db/client";
import { captureTool } from "../src/mcp/tools/capture";
import { processInboxFile } from "../src/pipeline/watcher";
import { config } from "../src/util/config";
import { resetDb, testSql } from "./helpers";

const inboxDir = join(config.dataDir, "inbox");

beforeEach(async () => {
  await resetDb();
  await rm(inboxDir, { recursive: true, force: true });
  await mkdir(inboxDir, { recursive: true });
});

describe("MCP capture durability", () => {
  test("published capture identity survives its outer transaction rollback with actor provenance", async () => {
    const actor = "agent:durability-probe";
    let receiptId = "";

    await expect(
      withDbTransaction(async () => {
        const result = await captureTool.handler(
          { text: "todo: catalogue the fictional opal compass cards by 2027-08-08" },
          { actor },
        );
        receiptId = (result.data as { inbox_item_id: string }).inbox_item_id;
        throw new Error("forced_outer_capture_rollback");
      }),
    ).rejects.toThrow("forced_outer_capture_rollback");

    const [captured] = await testSql`
      select id, raw_path, status, created_by, source
      from inbox_items where id = ${receiptId}`;
    expect(captured).toMatchObject({
      id: receiptId,
      status: "pending",
      created_by: actor,
      source: "capture",
    });
    expect(await Bun.file(captured!.raw_path).exists()).toBe(true);

    const filed = await processInboxFile(captured!.raw_path);
    expect(filed).toEqual({ inboxId: receiptId, filed: true });
    const [filedRow] = await testSql`
      select id, status, created_by from inbox_items where raw_path = ${captured!.raw_path}`;
    expect(filedRow).toEqual({ id: receiptId, status: "filed", created_by: actor });
    expect(await testSql`select id from tasks where derived_from = ${receiptId}`).toHaveLength(1);
  });

  test("publication failure durably rejects the preallocated actor identity", async () => {
    const actor = "agent:publication-failure";
    await rm(inboxDir, { recursive: true, force: true });
    await writeFile(inboxDir, "fictional path blocker");

    try {
      await expect(
        withDbTransaction(() =>
          captureTool.handler(
            { text: "todo: sort the fictional moon-glass labels by 2027-09-09" },
            { actor },
          ),
        ),
      ).rejects.toThrow();
    } finally {
      await rm(inboxDir, { force: true });
      await mkdir(inboxDir, { recursive: true });
    }

    const [rejected] = await testSql`
      select status, created_by, source, classifier_output
      from inbox_items where created_by = ${actor}`;
    expect(rejected).toEqual({
      status: "rejected",
      created_by: actor,
      source: "capture",
      classifier_output: {
        rejected: true,
        reason: "capture source publication failed",
      },
    });
  });
});
