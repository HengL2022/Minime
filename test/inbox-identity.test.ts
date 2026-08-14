import { beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { withDbTransaction } from "../src/db/client";
import {
  claimInboxItem,
  ensureInboxItemIdentity,
  findInboxByIdentity,
  getInboxItem,
  markInboxClaimRetryable,
  retryableInboxItems,
  setInboxClassification,
} from "../src/db/repo";
import { processInboxFile, startWatcher } from "../src/pipeline/watcher";
import { atomicWritePrivate } from "../src/util/atomic-file";
import { config } from "../src/util/config";
import { expectSqlReject, resetDb, testSql } from "./helpers";

const inboxDir = join(config.dataDir, "inbox");
// Bun's default test timeout is 5s; waitForFiledIdentity can wait 10s, and a
// loaded CI runner often needs two sequential file+process cycles.
const WATCHER_TEST_TIMEOUT_MS = 20_000;

function sha256(value: string | Uint8Array): string {
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

async function waitForFiledIdentity(
  rawPath: string,
  contentHash: string,
  timeoutMs = 10_000,
): Promise<{ id: string; archive_path: string }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [row] = await testSql`
      select id, status, archive_path
      from inbox_items
      where raw_path = ${rawPath} and content_hash = ${contentHash}`;
    if (row?.status === "filed" && row.archive_path) {
      return { id: String(row.id), archive_path: String(row.archive_path) };
    }
    await Bun.sleep(50);
  }
  throw new Error("watcher did not file stable inbox identity before timeout");
}

beforeAll(async () => {
  await resetDb();
  await mkdir(inboxDir, { recursive: true });
});

describe("inbox byte identity (classifier mocked by the test preload)", () => {
  test("schema rejects malformed hashes, unfenced processing, and identity rewrites", async () => {
    await expectSqlReject(
      testSql`insert into inbox_items (raw_path, content_hash) values ('schema-bad-hash', 'ABC')`,
      /inbox_items_content_hash_sha256_check/,
    );
    await expectSqlReject(
      testSql`insert into inbox_items (raw_path, status) values ('schema-bad-claim', 'processing')`,
      /inbox_items_processing_claim_check/,
    );
    await expectSqlReject(
      testSql`insert into inbox_items (raw_path, archive_path) values ('schema-bad-archive', '/tmp/outside.md')`,
      /inbox_items_archive_path_relative_check/,
    );

    const identityHash = sha256("schema identity probe");
    const [item] = await testSql`
      insert into inbox_items (raw_path, status, content_hash, archive_path)
      values ('schema-immutable', 'rejected', ${identityHash}, 'archive/2027/01/schema-immutable.md')
      returning id`;
    await expectSqlReject(
      testSql`update inbox_items set raw_path = 'schema-rewritten' where id = ${item!.id}`,
      /inbox_capture_identity_immutable/,
    );
    await expectSqlReject(
      testSql`update inbox_items set content_hash = ${sha256("different")} where id = ${item!.id}`,
      /inbox_capture_identity_immutable/,
    );
    await expectSqlReject(
      testSql`update inbox_items set archive_path = 'archive/2027/01/other.md' where id = ${item!.id}`,
      /inbox_capture_identity_immutable/,
    );
  });

  test("unchanged bytes at one path reuse one inbox identity, derivative, event, and archive", async () => {
    const path = join(inboxDir, "identity-replay.md");
    const bytes = "todo: label the fictional tidepool sample trays by 2027-02-01";
    await Bun.write(path, bytes);

    const first = await processInboxFile(path);
    const replay = await processInboxFile(path);

    expect(replay.inboxId).toBe(first.inboxId);
    const identities = await testSql`
      select id, status, archive_path from inbox_items where raw_path = ${path}`;
    expect(identities).toHaveLength(1);
    expect(identities[0]!.status).toBe("filed");
    expect(String(identities[0]!.archive_path)).toContain(first.inboxId);

    const derivatives = await testSql`
      select id from tasks where derived_from = ${first.inboxId}`;
    expect(derivatives).toHaveLength(1);
    const filedEvents = await testSql`
      select id from events
      where verb = 'inbox:filed' and entity_id = ${first.inboxId}`;
    expect(filedEvents).toHaveLength(1);
    const archivePath = join(config.dataDir, String(identities[0]!.archive_path));
    expect(await readFile(archivePath, "utf8")).toBe(bytes);
    expect(
      (await readdir(dirname(archivePath))).filter((name) => name.startsWith(`${first.inboxId}-`)),
    ).toHaveLength(1);

    await Bun.write(archivePath, "tampered archive bytes");
    let collision: unknown;
    try {
      await processInboxFile(path);
    } catch (error) {
      collision = error;
    }
    expect(String(collision)).toContain("inbox_immutable_file_collision");
    expect(await readFile(archivePath, "utf8")).toBe("tampered archive bytes");
    await Bun.write(archivePath, bytes);
  });

  test("unchanged low-confidence replay keeps one review item and event", async () => {
    const path = join(inboxDir, "identity-review-replay.md");
    await Bun.write(path, "unclear: fictional quartz notation");

    const first = await processInboxFile(path);
    const replay = await processInboxFile(path);

    expect(replay).toEqual(first);
    expect(first.filed).toBe(false);
    expect(
      await testSql`
        select id from review_queue
        where kind = 'inbox_unfiled'
          and payload->>'inbox_item_id' = ${first.inboxId}`,
    ).toHaveLength(1);
    expect(
      await testSql`
        select id from events
        where verb = 'inbox:unfiled' and entity_id = ${first.inboxId}`,
    ).toHaveLength(1);
  });

  test("changed bytes at one path create immutable versions and replaying old bytes finds the old identity", async () => {
    const path = join(inboxDir, "mutable-source.md");
    const bytesA =
      "reference for the imaginary reed archive\n\nblue tags denote samples collected before sunrise.";
    const bytesB =
      "reference for the imaginary basalt archive\n\namber tags denote samples collected after sunset.";

    await Bun.write(path, bytesA);
    const versionA = await processInboxFile(path);
    await Bun.write(path, bytesB);
    const versionB = await processInboxFile(path);
    await Bun.write(path, bytesA);
    const replayA = await processInboxFile(path);

    expect(versionB.inboxId).not.toBe(versionA.inboxId);
    expect(replayA.inboxId).toBe(versionA.inboxId);
    const identities = await testSql`
      select id, archive_path from inbox_items where raw_path = ${path} order by id`;
    expect(identities).toHaveLength(2);

    const [storedA] = identities.filter((row) => row.id === versionA.inboxId);
    const [storedB] = identities.filter((row) => row.id === versionB.inboxId);
    expect(storedA).toBeTruthy();
    expect(storedB).toBeTruthy();
    expect(storedA!.archive_path).not.toBe(storedB!.archive_path);
    expect(await readFile(join(config.dataDir, String(storedA!.archive_path)), "utf8")).toBe(
      bytesA,
    );
    expect(await readFile(join(config.dataDir, String(storedB!.archive_path)), "utf8")).toBe(
      bytesB,
    );

    expect(
      await testSql`select id from pages where derived_from = ${versionA.inboxId}`,
    ).toHaveLength(1);
    expect(
      await testSql`select id from pages where derived_from = ${versionB.inboxId}`,
    ).toHaveLength(1);
    expect(
      await testSql`
        select id from events
        where verb = 'inbox:filed' and entity_id = ${versionA.inboxId}`,
    ).toHaveLength(1);
  });

  test("same-title note captures get distinct pages and full inbox-ID-suffixed files", async () => {
    const title = "fictional lantern archive field note";
    const textA = `${title}\n\nfirst observation: the paper marker remained silver overnight.`;
    const textB = `${title}\n\nsecond observation: the paper marker remained violet overnight.`;
    const pathA = join(inboxDir, "same-title-a.md");
    const pathB = join(inboxDir, "same-title-b.md");
    await Bun.write(pathA, textA);
    await Bun.write(pathB, textB);

    const captureA = await processInboxFile(pathA);
    const captureB = await processInboxFile(pathB);
    const [pageA] = await testSql`
      select id, path, title, body_md from pages where derived_from = ${captureA.inboxId}`;
    const [pageB] = await testSql`
      select id, path, title, body_md from pages where derived_from = ${captureB.inboxId}`;

    expect(pageA!.id).not.toBe(pageB!.id);
    expect(pageA!.title).toBe(title);
    expect(pageB!.title).toBe(title);
    expect(pageA!.path).toBe(`inbox/fictional-lantern-archive-field-note--${captureA.inboxId}.md`);
    expect(pageB!.path).toBe(`inbox/fictional-lantern-archive-field-note--${captureB.inboxId}.md`);
    expect(await readFile(join(config.dataDir, "brain", pageA!.path), "utf8")).toBe(pageA!.body_md);
    expect(await readFile(join(config.dataDir, "brain", pageB!.path), "utf8")).toBe(pageB!.body_md);
  });

  test("concurrent processing converges on one identity, derivative, and filed event", async () => {
    const path = join(inboxDir, "concurrent-replay.md");
    const bytes = "todo: catalogue the imaginary basalt tokens by 2027-03-03";
    await Bun.write(path, bytes);

    const results = await Promise.all(Array.from({ length: 12 }, () => processInboxFile(path)));
    expect(new Set(results.map((result) => result.inboxId)).size).toBe(1);
    const inboxId = results[0]!.inboxId;

    expect(await testSql`select id from inbox_items where raw_path = ${path}`).toHaveLength(1);
    expect(await testSql`select id from tasks where derived_from = ${inboxId}`).toHaveLength(1);
    expect(
      await testSql`
        select id from events where verb = 'inbox:filed' and entity_id = ${inboxId}`,
    ).toHaveLength(1);
    const [identity] = await testSql`
      select archive_path from inbox_items where id = ${inboxId}`;
    expect(await readFile(join(config.dataDir, String(identity!.archive_path)), "utf8")).toBe(
      bytes,
    );
  });

  test("a file-visible capture transaction and watcher converge on the preallocated identity", async () => {
    const path = join(inboxDir, "capture-watcher-race.md");
    const bytes = "todo: arrange the fictional glass compass cards by 2027-03-13";
    let publishIdentity!: (id: string) => void;
    const visibleIdentity = new Promise<string>((resolveIdentity) => {
      publishIdentity = resolveIdentity;
    });
    let releaseCommit!: () => void;
    const commitGate = new Promise<void>((release) => {
      releaseCommit = release;
    });

    const captureTransaction = withDbTransaction(async () => {
      const identity = await ensureInboxItemIdentity({
        rawPath: path,
        contentHash: sha256(bytes),
        mime: "text/markdown",
        createdBy: "agent:test-capture",
      });
      await atomicWritePrivate(path, bytes);
      publishIdentity(identity.id);
      await commitGate;
    });

    const preallocatedId = await visibleIdentity;
    const watcherWork = processInboxFile(path);
    await Bun.sleep(25);
    releaseCommit();
    await captureTransaction;
    const result = await watcherWork;

    expect(result).toEqual({ inboxId: preallocatedId, filed: true });
    expect(await testSql`select id from inbox_items where raw_path = ${path}`).toHaveLength(1);
    expect(await testSql`select id from tasks where derived_from = ${preallocatedId}`).toHaveLength(
      1,
    );
  });

  test("a final filed-status failure rolls back note derivatives and retry converges once", async () => {
    const path = join(inboxDir, "rollback-note.md");
    const sentinel = "quartz-retry-sentinel-731";
    const text = `rollback probe reference\n\n${sentinel} marks an entirely fictional archive entry.`;
    const countsBefore = await testSql`
      select
        (select count(*)::int from pages) as pages,
        (select count(*)::int from chunks) as chunks,
        (select count(*)::int from edges) as edges`;
    await Bun.write(path, text);

    await testSql.unsafe(`
      create function test_fail_inbox_filed() returns trigger as $$
      begin
        if new.status = 'filed' then
          raise exception 'forced_inbox_filed_failure';
        end if;
        return new;
      end;
      $$ language plpgsql
    `);
    await testSql.unsafe(`
      create trigger test_fail_inbox_filed
      before update of status on inbox_items
      for each row execute function test_fail_inbox_filed()
    `);

    let failure: unknown;
    try {
      await processInboxFile(path);
    } catch (error) {
      failure = error;
    } finally {
      await testSql.unsafe("drop trigger if exists test_fail_inbox_filed on inbox_items");
      await testSql.unsafe("drop function if exists test_fail_inbox_filed()");
    }

    expect(String(failure)).toContain("forced_inbox_filed_failure");
    const [failedItem] = await testSql`
      select id, status from inbox_items where raw_path = ${path}`;
    expect(failedItem!.status).toBe("processing");
    expect(await testSql`select id from pages where derived_from = ${failedItem!.id}`).toHaveLength(
      0,
    );
    expect(await testSql`select id from chunks where text like ${`%${sentinel}%`}`).toHaveLength(0);
    expect(
      await testSql`
        select id from events
        where verb = 'inbox:filed' and entity_id = ${failedItem!.id}`,
    ).toHaveLength(0);
    const countsAfterFailure = await testSql`
      select
        (select count(*)::int from pages) as pages,
        (select count(*)::int from chunks) as chunks,
        (select count(*)::int from edges) as edges`;
    expect(countsAfterFailure[0]).toEqual(countsBefore[0]);
    const projectionPath = join(
      config.dataDir,
      "brain",
      "inbox",
      `rollback-probe-reference--${failedItem!.id}.md`,
    );
    expect(await exists(projectionPath)).toBe(false);

    const retry = await processInboxFile(path);
    expect(retry).toEqual({ inboxId: failedItem!.id, filed: true });
    const pages = await testSql`
      select id, path from pages where derived_from = ${failedItem!.id}`;
    expect(pages).toHaveLength(1);
    expect(
      await testSql`
        select id from chunks where parent_type = 'page' and parent_id = ${pages[0]!.id}`,
    ).not.toHaveLength(0);
    expect(
      await testSql`
        select id from events
        where verb = 'inbox:filed' and entity_id = ${failedItem!.id}`,
    ).toHaveLength(1);
    expect(await readFile(projectionPath, "utf8")).toBe(`# rollback probe reference\n\n${text}`);
  });

  test("a stale processing claim is reclaimable", async () => {
    const path = join(inboxDir, "stale-claim.md");
    const bytes = "todo: sort the imaginary cedar tokens by 2027-04-04";
    await Bun.write(path, bytes);
    const [stale] = await testSql`
      insert into inbox_items
        (raw_path, mime, status, content_hash, claim_token, claimed_at, created_by, source, tier)
      values
        (${path}, 'text/markdown', 'processing', ${sha256(bytes)}, ${randomUUID()}::uuid,
         clock_timestamp() - interval '10 minutes', 'agent:classifier', 'capture', 1)
      returning id`;

    const result = await processInboxFile(path);

    expect(result).toEqual({ inboxId: stale!.id, filed: true });
    const [item] = await testSql`
      select status, claim_token, claimed_at, archive_path from inbox_items where id = ${stale!.id}`;
    expect(item!.status).toBe("filed");
    expect(item!.claim_token).toBeNull();
    expect(item!.claimed_at).toBeNull();
    expect(await testSql`select id from tasks where derived_from = ${stale!.id}`).toHaveLength(1);
    expect(
      await testSql`
        select id from events where verb = 'inbox:filed' and entity_id = ${stale!.id}`,
    ).toHaveLength(1);
    expect(await readFile(join(config.dataDir, String(item!.archive_path)), "utf8")).toBe(bytes);
  });

  test(
    "a fresh crash lease wakes at expiry without another filesystem event",
    async () => {
      const path = join(inboxDir, "fresh-crash-lease.md");
      const bytes = "todo: catalogue the fictional onyx tabs by 2027-04-14";
      await Bun.write(path, bytes);
      const [fresh] = await testSql`
      insert into inbox_items
        (raw_path, mime, status, content_hash, claim_token, claimed_at, created_by, source, tier)
      values
        (${path}, 'text/markdown', 'processing', ${sha256(bytes)}, ${randomUUID()}::uuid,
         clock_timestamp() - interval '4 minutes 58 seconds',
         'agent:classifier', 'capture', 1)
      returning id`;

      const watcher = await startWatcher();
      try {
        const [beforeExpiry] = await testSql`
        select status from inbox_items where id = ${fresh!.id}`;
        expect(beforeExpiry!.status).toBe("processing");
        const filed = await waitForFiledIdentity(path, sha256(bytes));
        expect(filed.id).toBe(fresh!.id);
        expect(await testSql`select id from tasks where derived_from = ${fresh!.id}`).toHaveLength(
          1,
        );
      } finally {
        await watcher.close();
      }
    },
    WATCHER_TEST_TIMEOUT_MS,
  );

  test(
    "recovery finds a deterministic archive published before archive_path committed",
    async () => {
      const path = join(inboxDir, "archive-gap.md");
      const archivedBytes = "todo: inventory the fictional topaz reels by 2027-04-21";
      const currentBytes = "todo: map the fictional violet cairns by 2027-04-22";
      await Bun.write(path, currentBytes);
      const [stale] = await testSql`
      insert into inbox_items
        (raw_path, mime, status, content_hash, claim_token, claimed_at, created_by, source, tier)
      values
        (${path}, 'text/markdown', 'processing', ${sha256(archivedBytes)}, ${randomUUID()}::uuid,
         clock_timestamp() - interval '10 minutes', 'agent:classifier', 'capture', 1)
      returning id, received_at`;
      const receivedAt = new Date(stale!.received_at);
      const relativeArchive = join(
        "archive",
        String(receivedAt.getUTCFullYear()),
        String(receivedAt.getUTCMonth() + 1).padStart(2, "0"),
        `${stale!.id}-archive-gap.md`,
      );
      await atomicWritePrivate(join(config.dataDir, relativeArchive), archivedBytes);

      const watcher = await startWatcher();
      try {
        const recovered = await waitForFiledIdentity(path, sha256(archivedBytes));
        const changed = await waitForFiledIdentity(path, sha256(currentBytes));
        expect(recovered.id).toBe(stale!.id);
        expect(changed.id).not.toBe(stale!.id);
        const [healed] = await testSql`
        select status, archive_path from inbox_items where id = ${stale!.id}`;
        expect(healed).toEqual({ status: "filed", archive_path: relativeArchive });
        expect(await readFile(join(config.dataDir, relativeArchive), "utf8")).toBe(archivedBytes);
      } finally {
        await watcher.close();
      }
    },
    WATCHER_TEST_TIMEOUT_MS,
  );

  test("a reclaimed item fences the old claim token from late writes", async () => {
    const path = join(inboxDir, "claim-fence.md");
    const bytes = "todo: index the fictional moon-shell cards by 2027-05-05";
    await Bun.write(path, bytes);
    const item = await ensureInboxItemIdentity({
      rawPath: path,
      contentHash: sha256(bytes),
      mime: "text/markdown",
      createdBy: "agent:test",
    });
    const first = await claimInboxItem(item.id);
    expect(first).not.toBeNull();
    await testSql`
      update inbox_items set claimed_at = clock_timestamp() - interval '10 minutes'
      where id = ${item.id}`;
    const second = await claimInboxItem(item.id);
    expect(second).not.toBeNull();
    expect(second!.token).not.toBe(first!.token);

    let lateError: unknown;
    try {
      await setInboxClassification(item.id, first!.token, {
        type: "task",
        confidence: 1,
        fields: { title: "late stale write" },
      });
    } catch (error) {
      lateError = error;
    }
    expect(String(lateError)).toContain("inbox_claim_lost");

    await markInboxClaimRetryable(item.id, second!.token);
    expect(await processInboxFile(path)).toEqual({ inboxId: item.id, filed: true });
    expect(await testSql`select id from tasks where derived_from = ${item.id}`).toHaveLength(1);
  });

  test(
    "startup preserves first-seen bytes beside an unhashed terminal legacy row and later edits",
    async () => {
      const path = join(inboxDir, "legacy-terminal-change.md");
      const legacyBytes = "legacy capture bytes with no trustworthy historical digest";
      const changedBytes = "todo: file the new fictional amber index cards by 2027-06-06";
      await Bun.write(path, legacyBytes);
      const [legacy] = await testSql`
      insert into inbox_items (raw_path, status, classifier_output, created_by, source)
      values (${path}, 'filed', ${testSql.json({ legacy: true })}, 'human', 'capture')
      returning id`;

      const firstWatcher = await startWatcher();
      try {
        const beforeChange = await testSql`
        select id, content_hash
        from inbox_items where raw_path = ${path}`;
        expect(beforeChange).toHaveLength(2);
        expect(beforeChange.some((row) => row.id === legacy!.id && row.content_hash == null)).toBe(
          true,
        );
        const firstObserved = await waitForFiledIdentity(path, sha256(legacyBytes));
        expect(firstObserved.id).not.toBe(legacy!.id);
      } finally {
        await firstWatcher.close();
      }

      // No watcher is running: the next startup scan must detect this changed baseline.
      await Bun.write(path, changedBytes);
      const secondWatcher = await startWatcher();
      try {
        const changed = await waitForFiledIdentity(path, sha256(changedBytes));
        expect(changed.id).not.toBe(legacy!.id);
        expect(await testSql`select id from inbox_items where raw_path = ${path}`).toHaveLength(3);
      } finally {
        await secondWatcher.close();
      }
    },
    WATCHER_TEST_TIMEOUT_MS,
  );

  test(
    "startup processing failure remains retryable instead of rejecting a present source",
    async () => {
      const path = join(inboxDir, "startup-retryable.md");
      const bytes = "todo: sort the fictional mica cards by 2027-07-07";
      await Bun.write(path, bytes);
      const [item] = await testSql`
      insert into inbox_items
        (raw_path, mime, status, content_hash, claim_token, claimed_at, created_by, source, tier)
      values
        (${path}, 'text/markdown', 'processing', ${sha256(bytes)}, ${randomUUID()}::uuid,
         clock_timestamp() - interval '10 minutes', 'agent:classifier', 'capture', 1)
      returning id`;

      await testSql.unsafe(`
      create function test_fail_startup_filed() returns trigger as $$
      begin
        if new.status = 'filed' then
          raise exception 'forced_startup_filed_failure';
        end if;
        return new;
      end;
      $$ language plpgsql
    `);
      await testSql.unsafe(`
      create trigger test_fail_startup_filed
      before update of status on inbox_items
      for each row execute function test_fail_startup_filed()
    `);

      try {
        const watcher = await startWatcher();
        await watcher.close();
        const [failed] = await testSql`
        select status, classifier_output from inbox_items where id = ${item!.id}`;
        expect(failed!.status).toBe("processing");
        expect(failed!.classifier_output).not.toBeNull();
      } finally {
        await testSql.unsafe("drop trigger if exists test_fail_startup_filed on inbox_items");
        await testSql.unsafe("drop function if exists test_fail_startup_filed()");
      }
      expect(await processInboxFile(path)).toEqual({ inboxId: item!.id, filed: true });
    },
    WATCHER_TEST_TIMEOUT_MS,
  );

  test(
    "duplicate untouched legacy rows converge to one identity and one audited rejection",
    async () => {
      const path = join(inboxDir, "legacy-duplicate.md");
      const bytes = "todo: label the fictional nacre trays by 2027-07-17";
      await Bun.write(path, bytes);
      const legacyRows = await testSql`
      insert into inbox_items (raw_path, status, created_by, source, tier)
      values
        (${path}, 'pending', 'human', 'capture', 1),
        (${path}, 'pending', 'human', 'capture', 1)
      returning id`;

      const watcher = await startWatcher();
      try {
        const filed = await waitForFiledIdentity(path, sha256(bytes));
        expect(legacyRows.some((row) => row.id === filed.id)).toBe(true);
        const rows = await testSql`
        select id, status, content_hash from inbox_items
        where raw_path = ${path} order by id`;
        expect(rows).toHaveLength(2);
        expect(
          rows.filter((row) => row.status === "filed" && row.content_hash != null),
        ).toHaveLength(1);
        const [duplicate] = rows.filter(
          (row) => row.status === "rejected" && row.content_hash == null,
        );
        expect(duplicate).toBeTruthy();
        expect(
          await testSql`
          select id from events
          where verb = 'inbox:legacy-duplicate' and entity_id = ${duplicate!.id}`,
        ).toHaveLength(1);
      } finally {
        await watcher.close();
      }
    },
    WATCHER_TEST_TIMEOUT_MS,
  );

  test("repository inbox content reads and claims exclude tier zero", async () => {
    const path = join(inboxDir, "tier-zero-poison.md");
    const contentHash = sha256("tier zero inbox poison probe");
    const [tierZero] = await testSql`
      insert into inbox_items (raw_path, content_hash, status, created_by, source, tier)
      values (${path}, ${contentHash}, 'pending', 'human', 'capture', 0)
      returning id`;

    expect(await getInboxItem(tierZero!.id)).toBeNull();
    expect(await findInboxByIdentity(path, contentHash)).toBeNull();
    expect(await claimInboxItem(tierZero!.id)).toBeNull();
    expect((await retryableInboxItems()).some((row) => row.id === tierZero!.id)).toBe(false);
    const [unchanged] = await testSql`
      select status, claim_token from inbox_items where id = ${tierZero!.id}`;
    expect(unchanged).toEqual({ status: "pending", claim_token: null });
  });

  test(
    "the real watcher files a stable content change at an existing path",
    async () => {
      const path = join(inboxDir, "watcher-change.md");
      const bytesA =
        "watcher reference for a fictional paper garden\n\nthe first stable version uses a copper marker.";
      const bytesB =
        "watcher reference for a fictional paper garden\n\nthe second stable version uses a cobalt marker.";
      const watcher = await startWatcher();
      try {
        await Bun.write(path, bytesA);
        const versionA = await waitForFiledIdentity(path, sha256(bytesA));
        await Bun.write(path, bytesB);
        const versionB = await waitForFiledIdentity(path, sha256(bytesB));

        expect(versionB.id).not.toBe(versionA.id);
        expect(await testSql`select id from inbox_items where raw_path = ${path}`).toHaveLength(2);
        expect(await readFile(join(config.dataDir, versionA.archive_path), "utf8")).toBe(bytesA);
        expect(await readFile(join(config.dataDir, versionB.archive_path), "utf8")).toBe(bytesB);
        expect(
          await testSql`
          select id from events
          where verb = 'inbox:filed' and entity_id in (${versionA.id}, ${versionB.id})`,
        ).toHaveLength(2);
      } finally {
        await watcher.close();
      }
    },
    WATCHER_TEST_TIMEOUT_MS,
  );
});
