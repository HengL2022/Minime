// Watcher seam: parse markdown for classify; parse failure → inbox_unfiled, never drop.
import { beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { access, mkdir, readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { buildTextPdf, corruptPdfBytes } from "../fixtures/parse/text-pdf";
import { ensureInboxItemIdentity, getInboxItem } from "../src/db/repo";
import { processInboxFile, readArchivedCapture } from "../src/pipeline/watcher";
import { config } from "../src/util/config";
import { resetDb, testSql } from "./helpers";

const inboxDir = join(config.dataDir, "inbox");

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function expectOriginalStored(
  inboxId: string,
  bytes: Uint8Array,
  rawPath: string,
): Promise<void> {
  const inbox = await getInboxItem(inboxId);
  expect(inbox?.content_hash).toBe(sha256(bytes));
  const year = new Date(inbox!.received_at).getUTCFullYear();
  const ext =
    extname(rawPath)
      .replace(/[^a-zA-Z0-9.]/g, "")
      .slice(0, 16) || ".bin";
  const rel = `files/${year}/${inbox!.content_hash}${ext}`;
  expect(Buffer.from(await readFile(join(config.dataDir, rel)))).toEqual(Buffer.from(bytes));
  const matches = (await readFile(join(config.dataDir, "files", "manifest.ndjson"), "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((row) => row.hash === inbox!.content_hash);
  expect(matches).toHaveLength(1);
  expect(matches[0]).toEqual({
    hash: inbox!.content_hash,
    path: rel,
    ext,
    year,
    inbox_id: inboxId,
  });
}

beforeAll(async () => {
  await resetDb();
  await mkdir(inboxDir, { recursive: true });
});

describe("inbox parse seam", () => {
  test("corrupt PDF becomes one pending unfiled identity, never a filed row", async () => {
    const bytes = corruptPdfBytes();
    const path = join(inboxDir, "corrupt-tidepool.pdf");
    await Bun.write(path, bytes);

    const first = await processInboxFile(path);
    const replay = await processInboxFile(path);

    expect(replay).toEqual(first);
    expect(first.filed).toBe(false);

    const items = await testSql`
      select id, mime, status, filed_table, filed_id, classifier_output, archive_path, content_hash
      from inbox_items where raw_path = ${path}`;
    expect(items).toHaveLength(1);
    const item = items[0]!;
    expect(item.id).toBe(first.inboxId);
    expect(item.mime).toBe("application/pdf");
    expect(item.status).toBe("pending");
    expect(item.filed_table).toBeNull();
    expect(item.filed_id).toBeNull();
    expect(item.content_hash).toBe(sha256(bytes));
    expect(item.classifier_output).toEqual({
      type: "unknown",
      confidence: 0,
      reason: "parse_failed",
      fields: { mime: "application/pdf", code: "parse_failed" },
    });
    expect(JSON.stringify(item.classifier_output)).not.toContain("readable content stream");

    const archivePath = join(config.dataDir, String(item.archive_path));
    expect(await exists(archivePath)).toBe(true);
    expect(Buffer.from(await readFile(archivePath))).toEqual(Buffer.from(bytes));
    await expectOriginalStored(first.inboxId, bytes, path);

    expect(
      await testSql`
        select id from review_queue
        where kind = 'inbox_unfiled' and payload->>'inbox_item_id' = ${first.inboxId}`,
    ).toHaveLength(1);
    const unfiledEvents = await testSql`
      select payload from events
      where verb = 'inbox:unfiled' and entity_id = ${first.inboxId}`;
    expect(unfiledEvents).toHaveLength(1);
    expect(unfiledEvents[0]!.payload).toEqual({ type: "unknown", confidence: 0 });

    expect(await testSql`select id from tasks where derived_from = ${first.inboxId}`).toHaveLength(
      0,
    );
    expect(await testSql`select id from pages where derived_from = ${first.inboxId}`).toHaveLength(
      0,
    );
    expect(
      await testSql`select id from journal_entries where derived_from = ${first.inboxId}`,
    ).toHaveLength(0);
    expect(
      await testSql`select id from interactions where derived_from = ${first.inboxId}`,
    ).toHaveLength(0);
    expect(
      await testSql`select id from decisions where derived_from = ${first.inboxId}`,
    ).toHaveLength(0);
    const inbox = await getInboxItem(first.inboxId);
    expect(await readArchivedCapture(inbox!)).toBeNull();
  });

  test("reused identity picks up parser mime on the claimed row", async () => {
    const bytes = corruptPdfBytes();
    const path = join(inboxDir, "reuse-mime.pdf");
    await Bun.write(path, bytes);
    const created = await ensureInboxItemIdentity({
      rawPath: path,
      contentHash: sha256(bytes),
      mime: "text/plain",
      createdBy: "agent:classifier",
      source: "capture",
    });
    expect(created.mime).toBe("text/plain");

    const result = await processInboxFile(path);
    expect(result.inboxId).toBe(created.id);
    const [row] = await testSql`select mime, status from inbox_items where id = ${created.id}`;
    expect(row!.mime).toBe("application/pdf");
    expect(row!.status).toBe("pending");
  });

  test("a readable PDF is classified from extracted markdown, hashed as original bytes", async () => {
    const text = "todo: label the fictional tidepool sample trays by 2027-02-01";
    const bytes = buildTextPdf(text);
    const path = join(inboxDir, "readable-tidepool.pdf");
    await Bun.write(path, bytes);

    const result = await processInboxFile(path);
    expect(result.filed).toBe(true);
    const [item] = await testSql`
      select mime, status, filed_table, content_hash, archive_path
      from inbox_items where id = ${result.inboxId}`;
    expect(item!.mime).toBe("application/pdf");
    expect(item!.status).toBe("filed");
    expect(item!.filed_table).toBe("tasks");
    expect(item!.content_hash).toBe(sha256(bytes));
    expect(Buffer.from(await readFile(join(config.dataDir, String(item!.archive_path))))).toEqual(
      Buffer.from(bytes),
    );
    await expectOriginalStored(result.inboxId, bytes, path);
    const [task] = await testSql`select title from tasks where derived_from = ${result.inboxId}`;
    expect(task!.title).toContain("fictional tidepool sample trays");
    const inbox = await getInboxItem(result.inboxId);
    const archived = await readArchivedCapture(inbox!);
    expect(archived).toContain("fictional tidepool sample trays");
    expect(archived).not.toContain("%PDF");
  });

  test("existing markdown captures still auto-file under the mocked classifier", async () => {
    const path = join(inboxDir, "still-autofile.md");
    const body = "todo: reserve the imaginary kelp-lab bench by 2027-04-12";
    await Bun.write(path, body);
    const result = await processInboxFile(path);
    expect(result.filed).toBe(true);
    const [item] = await testSql`
      select mime, status, filed_table from inbox_items where id = ${result.inboxId}`;
    expect(item!.mime).toBe("text/markdown");
    expect(item!.status).toBe("filed");
    expect(item!.filed_table).toBe("tasks");
    await expectOriginalStored(result.inboxId, Buffer.from(body), path);
  });
});
