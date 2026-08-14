// W5 originals-store: content-addressed files/ + append-only manifest. Fictional fixtures only.
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildTextPdf, corruptPdfBytes } from "../fixtures/parse/text-pdf";
import { retryableInboxItems } from "../src/db/repo";
import { type OriginalsSource, storeInboxOriginal } from "../src/pipeline/originals";
import { processInboxFile } from "../src/pipeline/watcher";
import { config } from "../src/util/config";
import { resetDb, testSql } from "./helpers";

const PRIVATE_TMP = realpathSync(tmpdir());
const inboxDir = join(config.dataDir, "inbox");

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function source(partial: {
  id?: string;
  raw_path: string;
  content_hash: string;
  received_at?: Date;
}): OriginalsSource {
  return {
    id: partial.id ?? randomUUID(),
    raw_path: partial.raw_path,
    content_hash: partial.content_hash,
    received_at: partial.received_at ?? new Date(),
  };
}

async function readManifestLines(dataDir: string): Promise<unknown[]> {
  const text = await readFile(join(dataDir, "files", "manifest.ndjson"), "utf8");
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function linesForHash(lines: unknown[], hash: string): unknown[] {
  return lines.filter((row) => (row as { hash?: unknown }).hash === hash);
}

describe("originals store (direct)", () => {
  let originalDataDir: string;
  let root: string;

  beforeEach(async () => {
    originalDataDir = config.dataDir;
    root = await mkdtemp(join(PRIVATE_TMP, "minime-originals-"));
    await chmod(root, 0o755);
    config.dataDir = root;
  });

  afterEach(async () => {
    config.dataDir = originalDataDir;
    await rm(root, { recursive: true, force: true });
  });

  test("first store writes the hashed file and one manifest line", async () => {
    const bytes = Buffer.from("fictional kelp-lab tray labels");
    const hash = sha256(bytes);
    const receivedAt = new Date("2019-06-15T12:00:00.000Z");
    const item = source({
      raw_path: "inbox/tray-labels.md",
      content_hash: hash,
      received_at: receivedAt,
    });

    await storeInboxOriginal(item, bytes);

    const rel = `files/2019/${hash}.md`;
    const stored = join(root, rel);
    expect(Buffer.from(await readFile(stored))).toEqual(bytes);
    expect((await lstat(join(root, "files"))).mode & 0o777).toBe(0o700);
    expect((await lstat(join(root, "files", "2019"))).mode & 0o777).toBe(0o700);
    expect((await lstat(stored)).mode & 0o777).toBe(0o600);
    expect((await lstat(join(root, "files", "manifest.ndjson"))).mode & 0o777).toBe(0o600);

    const lines = await readManifestLines(root);
    expect(lines).toEqual([{ hash, path: rel, ext: ".md", year: 2019, inbox_id: item.id }]);
    expect(JSON.stringify(lines)).not.toContain("kelp-lab");
  });

  test("replay does not duplicate the file or the manifest line", async () => {
    const bytes = Buffer.from("fictional quartz notation cards");
    const hash = sha256(bytes);
    const item = source({
      raw_path: "inbox/quartz.txt",
      content_hash: hash,
      received_at: new Date("2021-03-01T00:00:00.000Z"),
    });

    await storeInboxOriginal(item, bytes);
    await storeInboxOriginal(item, bytes);

    const yearDir = join(root, "files", "2021");
    expect(await readdir(yearDir)).toEqual([`${hash}.txt`]);
    expect(await readManifestLines(root)).toHaveLength(1);
    expect(linesForHash(await readManifestLines(root), hash)).toHaveLength(1);
  });

  test("heal of a file without a manifest line appends once and does not rewrite bytes", async () => {
    const bytes = Buffer.from("fictional onyx tab catalogue");
    const hash = sha256(bytes);
    const receivedAt = new Date("2022-11-02T08:00:00.000Z");
    const rel = `files/2022/${hash}.bin`;
    await mkdir(join(root, "files", "2022"), { recursive: true, mode: 0o700 });
    await writeFile(join(root, rel), bytes, { mode: 0o600 });

    const item = source({
      raw_path: "inbox/onyx-tabs",
      content_hash: hash,
      received_at: receivedAt,
    });
    await storeInboxOriginal(item, bytes);
    await storeInboxOriginal(item, bytes);

    expect(Buffer.from(await readFile(join(root, rel)))).toEqual(bytes);
    expect(await readManifestLines(root)).toEqual([
      { hash, path: rel, ext: ".bin", year: 2022, inbox_id: item.id },
    ]);
  });

  test("collision with different bytes fails closed and does not append", async () => {
    const bytes = Buffer.from("fictional tidepool sample trays");
    const hash = sha256(bytes);
    const planted = Buffer.from("different fictional quartz bytes");
    const receivedAt = new Date("2023-01-01T00:00:00.000Z");
    const rel = `files/2023/${hash}.pdf`;
    await mkdir(join(root, "files", "2023"), { recursive: true, mode: 0o700 });
    await writeFile(join(root, rel), planted, { mode: 0o600 });

    const item = source({
      raw_path: "inbox/tidepool.pdf",
      content_hash: hash,
      received_at: receivedAt,
    });
    let failure: unknown;
    try {
      await storeInboxOriginal(item, bytes);
    } catch (error) {
      failure = error;
    }
    expect(String(failure)).toContain("inbox_original_collision");
    expect(String(failure)).not.toContain("tidepool");
    expect(String(failure)).not.toContain("quartz");
    expect(Buffer.from(await readFile(join(root, rel)))).toEqual(planted);

    let manifestMissing = false;
    try {
      await readManifestLines(root);
    } catch (error) {
      manifestMissing = (error as NodeJS.ErrnoException).code === "ENOENT";
    }
    expect(manifestMissing).toBe(true);
  });

  test("year is the UTC year of received_at and empty ext becomes .bin", async () => {
    const bytes = Buffer.from("fictional cedar token sort");
    const hash = sha256(bytes);
    const item = source({
      raw_path: "inbox/cedar-tokens",
      content_hash: hash,
      received_at: new Date("2019-12-31T23:30:00.000Z"),
    });
    await storeInboxOriginal(item, bytes);
    const [line] = await readManifestLines(root);
    expect(line).toEqual({
      hash,
      path: `files/2019/${hash}.bin`,
      ext: ".bin",
      year: 2019,
      inbox_id: item.id,
    });
  });
});

describe("originals store (inbox pipeline)", () => {
  beforeAll(async () => {
    await resetDb();
    await mkdir(inboxDir, { recursive: true });
  });

  test("a parse-failure PDF still stores originals and replay does not duplicate", async () => {
    const bytes = Buffer.concat([corruptPdfBytes(), Buffer.from("\n% originals-store fixture\n")]);
    const path = join(inboxDir, "originals-corrupt-tidepool.pdf");
    await Bun.write(path, bytes);

    const first = await processInboxFile(path);
    const replay = await processInboxFile(path);
    expect(replay).toEqual(first);
    expect(first.filed).toBe(false);

    const [item] = await testSql`
      select id, content_hash, received_at from inbox_items where id = ${first.inboxId}`;
    const hash = String(item!.content_hash);
    const year = new Date(item!.received_at).getUTCFullYear();
    const rel = `files/${year}/${hash}.pdf`;
    expect(hash).toBe(sha256(bytes));
    expect(Buffer.from(await readFile(join(config.dataDir, rel)))).toEqual(Buffer.from(bytes));

    const lines = linesForHash(await readManifestLines(config.dataDir), hash);
    expect(lines).toEqual([{ hash, path: rel, ext: ".pdf", year, inbox_id: first.inboxId }]);

    const names = await readdir(join(config.dataDir, "files", String(year)));
    expect(names.filter((name) => name.startsWith(hash))).toEqual([`${hash}.pdf`]);

    const events =
      await testSql`select verb, payload from events where entity_id = ${first.inboxId}`;
    const audit = JSON.stringify(events);
    const manifest = await readFile(join(config.dataDir, "files", "manifest.ndjson"), "utf8");
    for (const surface of [audit, manifest, JSON.stringify(lines)]) {
      expect(surface).not.toContain("%PDF");
      expect(surface).not.toContain("readable content stream");
    }
  });

  test("a readable PDF stores originals; audit and manifest never carry extracted text", async () => {
    const extracted = "todo: label the fictional originals-store tidepool trays by 2027-02-01";
    const bytes = buildTextPdf(extracted);
    const path = join(inboxDir, "originals-readable-tidepool.pdf");
    await Bun.write(path, bytes);

    const first = await processInboxFile(path);
    await processInboxFile(path);
    expect(first.filed).toBe(true);

    const [item] = await testSql`
      select content_hash, received_at from inbox_items where id = ${first.inboxId}`;
    const hash = String(item!.content_hash);
    const year = new Date(item!.received_at).getUTCFullYear();
    const rel = `files/${year}/${hash}.pdf`;
    expect(Buffer.from(await readFile(join(config.dataDir, rel)))).toEqual(Buffer.from(bytes));
    expect(linesForHash(await readManifestLines(config.dataDir), hash)).toHaveLength(1);

    const events =
      await testSql`select verb, payload from events where entity_id = ${first.inboxId}`;
    const audit = JSON.stringify(events);
    const manifest = await readFile(join(config.dataDir, "files", "manifest.ndjson"), "utf8");
    for (const surface of [audit, manifest]) {
      expect(surface).not.toContain("%PDF");
      expect(surface).not.toContain("fictional tidepool sample trays");
      expect(surface).not.toContain(extracted);
    }
  });

  test("a store collision after archive stays retryable and does not skip", async () => {
    const body = "todo: shelve the fictional basalt cores by 2027-08-01";
    const path = join(inboxDir, "originals-store-collision.md");
    await Bun.write(path, body);
    const hash = sha256(body);
    const year = new Date().getUTCFullYear();
    const planted = join(config.dataDir, "files", String(year), `${hash}.md`);
    await mkdir(join(config.dataDir, "files", String(year)), { recursive: true, mode: 0o700 });
    await writeFile(planted, "different fictional basalt bytes", { mode: 0o600 });

    let failure: unknown;
    try {
      await processInboxFile(path);
    } catch (error) {
      failure = error;
    }
    expect(String(failure)).toContain("inbox_original_collision");
    expect(String(failure)).not.toContain("basalt");
    expect(await readFile(planted, "utf8")).toBe("different fictional basalt bytes");
    let storedLines: unknown[] = [];
    try {
      storedLines = await readManifestLines(config.dataDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    expect(linesForHash(storedLines, hash)).toHaveLength(0);

    const retryable = await retryableInboxItems();
    expect(retryable.some((row) => row.raw_path === path)).toBe(true);
  });
});
