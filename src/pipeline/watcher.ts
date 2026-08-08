// Inbox pipeline (spec §10): snapshot a stable inbox file once, bind it to an immutable
// (raw_path, content_hash) identity + archive, then claim and transactionally file it.

import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { basename, extname, isAbsolute, join, relative, resolve } from "node:path";
import chokidar from "chokidar";
import { withDbTransaction } from "../db/client";
import {
  type InboxItem,
  assertInboxClaim,
  claimInboxItem,
  ensureInboxItemIdentity,
  ensureOrg,
  ensurePerson,
  exactActiveOrgExists,
  filedInboxNoteItems,
  getInboxItem,
  insertDecision,
  insertInteraction,
  insertJournal,
  insertReviewItem,
  logEvent,
  markInboxClaimRetryable,
  nextInboxClaimExpiry,
  openTasksForDedup,
  rejectDuplicateLegacyInboxItem,
  rejectRetryableInboxItem,
  retryableInboxItems,
  setInboxArchivePath,
  setInboxClassification,
  setInboxFiledClaimed,
  setInboxPendingClaimed,
  upsertPage,
  upsertTask,
} from "../db/repo";
import { drainEmbedBacklog, indexParent } from "../search/index-parent";
import {
  assertNoSymlinkComponents,
  atomicCreatePrivate,
  preflightPrivateRoot,
} from "../util/atomic-file";
import { auditPayload } from "../util/audit-payload";
import { todayStr } from "../util/clock";
import { config } from "../util/config";
import {
  type Classification,
  classify,
  completionSignal,
  completionTitle,
  orgCue,
  splitActionDecision,
} from "./classify";
import { findDuplicate } from "./dedup";

const ACTOR = "agent:classifier";
const CONFIDENCE_FLOOR = 0.7;
const RETRY_BACKOFF_MS = 5_000;
export type FiledTable = "tasks" | "journal_entries" | "interactions" | "pages" | "decisions";

export interface NoteProjection {
  absolutePath: string;
  body: string;
}

export interface FiledResult {
  primary: [FiledTable, string];
  projection?: NoteProjection;
}

const INDEX_OPTIONS = {
  strictEdgeExtraction: true,
  deferEmbeddings: true,
} as const;

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function containedPath(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return (
    rel === "" ||
    (!isAbsolute(rel) && rel !== ".." && !rel.startsWith("../") && !rel.startsWith("..\\"))
  );
}

function safeArchiveBasename(path: string): string {
  const extension = extname(path)
    .replace(/[^a-zA-Z0-9.]/g, "")
    .slice(0, 16);
  const stem = basename(path, extname(path))
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return `${stem || "capture"}${extension}`;
}

function archiveRelativePath(item: InboxItem): string {
  const receivedAt = new Date(item.received_at);
  const year = String(receivedAt.getUTCFullYear());
  const month = String(receivedAt.getUTCMonth() + 1).padStart(2, "0");
  return join("archive", year, month, `${item.id}-${safeArchiveBasename(item.raw_path)}`);
}

async function privateFilePath(relativePath: string): Promise<string> {
  if (isAbsolute(relativePath)) throw new Error("inbox_archive_path_invalid");
  const root = resolve(config.dataDir);
  const absolute = resolve(root, relativePath);
  if (!containedPath(root, absolute) || absolute === root)
    throw new Error("inbox_archive_path_invalid");
  await assertNoSymlinkComponents(root, absolute);
  return absolute;
}

async function readPrivateFile(relativePath: string): Promise<Buffer> {
  const absolute = await privateFilePath(relativePath);
  const stat = await lstat(absolute);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("inbox_archive_invalid");
  return readFile(absolute);
}

async function readInboxSource(path: string): Promise<{ path: string; bytes: Buffer }> {
  const inboxRoot = resolve(config.dataDir, "inbox");
  const absolute = resolve(path);
  if (!containedPath(inboxRoot, absolute) || absolute === inboxRoot)
    throw new Error("inbox_source_invalid");
  await assertNoSymlinkComponents(resolve(config.dataDir), absolute);
  const stat = await lstat(absolute);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("inbox_source_invalid");
  const canonical = await realpath(absolute);
  if (!containedPath(inboxRoot, canonical)) throw new Error("inbox_source_invalid");
  return { path: absolute, bytes: await readFile(absolute) };
}

async function publishSnapshot(
  target: string,
  bytes: Uint8Array,
  expectedHash: string,
): Promise<void> {
  const created = await atomicCreatePrivate(target, bytes);
  if (created) return;
  const existing = await readFile(target);
  if (sha256(existing) !== expectedHash) throw new Error("inbox_immutable_file_collision");
}

async function archiveSnapshot(
  item: InboxItem,
  claimToken: string,
  bytes: Uint8Array,
): Promise<void> {
  const relativePath = item.archive_path ?? archiveRelativePath(item);
  const absolutePath = await privateFilePath(relativePath);
  await publishSnapshot(absolutePath, bytes, item.content_hash!);
  await setInboxArchivePath(item.id, claimToken, relativePath);
}

async function verifyOrHealStoredArchive(item: InboxItem, bytes: Uint8Array): Promise<void> {
  if (!item.archive_path || !item.content_hash) return;
  const absolutePath = await privateFilePath(item.archive_path);
  await publishSnapshot(absolutePath, bytes, item.content_hash);
}

/**
 * Best-effort read of a capture's immutable archived text, hash-verified against the inbox
 * row's own content_hash (W2-2: review-queue read path). Reads ONLY the archive — never
 * item.raw_path, which is mutable, may have moved/been deleted, and must never cross the MCP
 * boundary. Returns null (never throws) whenever the bytes cannot be proven authentic: missing
 * identity, missing file, or a hash mismatch. A caller gating this behind a tier-2 unlock can
 * therefore fail closed on the text alone, rather than losing an otherwise-good enriched
 * review-queue item (e.g. its classifier type/confidence) to an unrelated archive fault.
 */
export async function readArchivedCapture(item: InboxItem): Promise<string | null> {
  if (!item.archive_path || !item.content_hash) return null;
  let bytes: Buffer;
  try {
    bytes = await readPrivateFile(item.archive_path);
  } catch {
    return null;
  }
  if (sha256(bytes) !== item.content_hash) return null;
  return bytes.toString("utf8");
}

const AGENT_SESSION_HINT_RE = /<!-- hint: agent work session -->/;

// Default note tier from the capture text alone: agent-session captures (SessionEnd hook)
// carry a fixed hint marker and file at tier 2 like journal/interactions; everything else
// defaults to tier 1. Exported so minime_refile (W2-3) can reuse the same signal when it
// floors an owner-requested note tier override against the capture's own evidence.
export function noteHintTier(text: string): 1 | 2 {
  return AGENT_SESSION_HINT_RE.test(text) ? 2 : 1;
}

function firstLineOf(text: string): string {
  return text
    .split("\n")[0]!
    .replace(/^<!--.*?-->\s*/s, "")
    .trim()
    .slice(0, 200);
}

function noteProjection(c: Classification, text: string, inboxId: string): NoteProjection {
  const firstLine = firstLineOf(text);
  const title = c.fields.title || firstLine;
  const slug =
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 60) || "note";
  const relPath = `inbox/${slug}--${inboxId}.md`;
  return {
    absolutePath: join(config.dataDir, "brain", relPath),
    body: `# ${title}\n\n${text}`,
  };
}

export async function publishNoteProjection(projection: NoteProjection): Promise<void> {
  await publishSnapshot(
    projection.absolutePath,
    Buffer.from(projection.body),
    sha256(projection.body),
  );
}

export function storedClassification(value: unknown): Classification | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<Classification>;
  if (
    !["task", "journal", "interaction", "note", "decision_note", "unknown"].includes(
      String(candidate.type),
    ) ||
    typeof candidate.confidence !== "number" ||
    !candidate.fields ||
    typeof candidate.fields !== "object"
  )
    return null;
  return candidate as Classification;
}

// Insert the typed row for a classification. Returns its primary row plus an optional note
// projection when filed, "duplicate" when it matched an existing open task (the duplicate review
// item is queued here), or null when unfileable. The caller owns the surrounding transaction.
// `actor` stamps created_by (and ensureOrg/ensurePerson's creator) on every row this call
// creates — it defaults to ACTOR for the watcher's own automatic-pipeline callers, but
// minime_refile (W2-3) passes its ctx.actor so an owner-initiated filing is attributed to the
// real MCP caller instead of the classifier (I5 provenance; invariant-review 2026-08-08). The
// bookkeeping events below (inbox:duplicate, inbox:split-decision, inbox:split-done-task,
// inbox:closed-existing-task) still log actor=ACTOR either way — the wrapping tool:minime_refile
// and inbox:refiled audit events already record the true actor for a refile-triggered call.
export async function fileRow(
  c: Classification,
  text: string,
  inboxId: string,
  actor: string = ACTOR,
): Promise<FiledResult | "duplicate" | null> {
  const firstLine = firstLineOf(text);
  switch (c.type) {
    case "task": {
      const title = c.fields.title || firstLine;
      // Date guardrail: accept a due date only if well-formed AND not in the past.
      // A past date almost always means the classifier guessed a wrong year for a
      // relative phrase ("tomorrow") despite the prompt anchor — store null instead of
      // a corrupt date, and flag it so the owner can set the real date at review.
      const rawDue =
        typeof c.fields.due === "string" && /^\d{4}-\d{2}-\d{2}$/.test(c.fields.due)
          ? c.fields.due
          : null;
      const today = todayStr();
      const duePast = rawDue !== null && rawDue < today;
      const due = duePast ? null : rawDue;

      // Does the capture REPORT finished work ("...— done")? A completion signal means
      // this should land as a done-task (and surface under the evening review's "what
      // moved today"), not as an open inbox task. Without this, "X — done" used to file
      // as status=inbox and silently vanish from the day review.
      const done = completionSignal(text);

      // Dedup: the classifier has no memory of existing rows, so a re-mentioned task
      // (event reminded twice) would otherwise create a second row. If an open task
      // closely matches, queue this capture for review instead of inserting a duplicate.
      const open = await openTasksForDedup();
      const dup = findDuplicate(title, due, open);
      if (dup) {
        // Consistency mechanism: a completion report that matches an existing OPEN task
        // must CLOSE that task, not queue a duplicate for review. Otherwise "X — done"
        // leaves the original "X" open forever and the completion is lost. Closing the
        // canonical row (rather than spawning a second done row) keeps one source of truth.
        if (done) {
          await upsertTask({
            id: dup.match.id,
            title: dup.match.title,
            status: "done",
            createdBy: actor,
          });
          await indexParent("task", dup.match.id, text, dup.match.title, 1, INDEX_OPTIONS);
          await logEvent({
            actor: ACTOR,
            verb: "inbox:closed-existing-task",
            entityType: "inbox_item",
            entityId: inboxId,
            payload: auditPayload.inboxClosedExistingTask({
              taskId: dup.match.id,
              score: dup.score,
            }),
          });
          return { primary: ["tasks", dup.match.id] };
        }
        await insertReviewItem("duplicate", {
          inbox_item_id: inboxId,
          candidate_title: title,
          candidate_due: due,
          existing_task_id: dup.match.id,
          existing_title: dup.match.title,
          score: Number(dup.score.toFixed(3)),
          note: "Inbox capture looks like an existing open task; review before filing.",
        });
        await logEvent({
          actor: ACTOR,
          verb: "inbox:duplicate",
          entityType: "inbox_item",
          entityId: inboxId,
          payload: auditPayload.inboxDuplicate({
            existingTaskId: dup.match.id,
            score: dup.score,
          }),
        });
        return "duplicate"; // queued as a duplicate; caller marks pending, no extra queue item
      }

      // Split compound "do X and decide on Y" captures: peel the decision clause off so the
      // task title is the ACTION only, and a companion decision row carries the open question.
      // Otherwise the combined phrasing files as one umbrella task that no later single capture
      // (the action-done report, or the decision) fully matches, so it never closes and
      // double-reports in the morning brief (the calibration-and-deployment bug). Only fires on a
      // non-completion capture with a real action clause + explicit decision verb.
      const split = done ? null : splitActionDecision(text);
      const taskTitle = split ? split.action.slice(0, 200) : title;

      const { id } = await upsertTask({
        title: taskTitle,
        body: duePast
          ? `${text}\n\n[date guardrail: classifier proposed past due date ${rawDue} (today ${today}); dropped — set the real date at review]`
          : text,
        due,
        status: done ? "done" : undefined,
        createdBy: actor,
        source: "capture",
        derivedFrom: inboxId,
      });
      await indexParent("task", id, text, taskTitle, 1, INDEX_OPTIONS);
      // The primary task and deterministic companion are one filing outcome. Any companion
      // failure aborts the outer inbox finalization transaction rather than leaving half a split.
      if (split) {
        const { id: decId } = await insertDecision({
          question: split.decision,
          options: [],
          choice: null,
          reasoning: `${text}\n\n[split from task ${id}: decision portion of a compound action+decision capture]`,
          createdBy: actor,
          source: "capture",
          derivedFrom: inboxId,
        });
        await indexParent("decision", decId, split.decision, split.decision, 1, INDEX_OPTIONS);
        await logEvent({
          actor: ACTOR,
          verb: "inbox:split-decision",
          entityType: "inbox_item",
          entityId: inboxId,
          payload: auditPayload.inboxSplitDecision({ taskId: id, decisionId: decId }),
        });
      }
      return { primary: ["tasks", id] };
    }
    case "journal": {
      const { id } = await insertJournal({
        entryMd: text,
        mood: typeof c.fields.mood === "number" ? c.fields.mood : null,
        createdBy: actor,
        source: "capture",
        derivedFrom: inboxId,
      });
      await indexParent("journal", id, text, `Journal ${todayStr()}`, 2, INDEX_OPTIONS);
      return { primary: ["journal_entries", id] };
    }
    case "interaction": {
      const name = c.fields.person_name || "Unknown";
      const kind = ["meeting", "call", "message", "email", "note"].includes(c.fields.kind)
        ? c.fields.kind
        : "note";
      // Decide person vs. org so a vendor/company never mints a phantom person (the
      // phantom-org bug). Precedence:
      //   1. an EXISTING org of this name always wins (attach history to it);
      //   2. else honour the classifier's explicit subject_type ("org" or "person");
      //   3. else (subject_type absent — legacy/synced captures, or model omission) fall
      //      back to a company cue in the NAME only. Name-only, not full text, so
      //      "met Tomasz at Fjordsonics, an acoustic sensing company" doesn't misfile Tomasz.
      // Minime owns this decision at ingestion — the caller (e.g. Hermes) only feeds raw text.
      const existingOrg = await exactActiveOrgExists(name);
      const st = c.fields.subject_type;
      const useOrg = !!existingOrg || st === "org" || (st !== "person" && orgCue(name));
      if (useOrg) {
        const org = await ensureOrg(name, actor, "capture", {
          tier: 2,
          derivedFrom: inboxId,
        });
        const { id } = await insertInteraction({
          orgId: org.id,
          kind,
          summary: text,
          createdBy: actor,
          source: "capture",
          derivedFrom: inboxId,
        });
        await indexParent("interaction", id, text, undefined, 2, INDEX_OPTIONS);
        return { primary: ["interactions", id] };
      }
      const person = await ensurePerson(name, actor, "capture", {
        tier: 2,
        derivedFrom: inboxId,
      });
      const { id } = await insertInteraction({
        personId: person.id,
        kind,
        summary: text,
        createdBy: actor,
        source: "capture",
        derivedFrom: inboxId,
      });
      await indexParent("interaction", id, text, undefined, 2, INDEX_OPTIONS);
      return { primary: ["interactions", id] };
    }
    case "decision_note": {
      const { id } = await insertDecision({
        question: c.fields.question || firstLine,
        options: Array.isArray(c.fields.options) ? c.fields.options : [],
        choice: typeof c.fields.choice === "string" ? c.fields.choice : null,
        reasoning: text,
        createdBy: actor,
        source: "capture",
        derivedFrom: inboxId,
      });
      await indexParent("decision", id, text, firstLine, 1, INDEX_OPTIONS);
      // Split mixed captures: a decision that ALSO reports finished work ("array calibration
      // done... but need to decide whether to use spare hydrophone nodes") would otherwise bury
      // the accomplishment in the decision's reasoning, where the evening review's "what
      // moved today" (done tasks + closed commitments) can't see it. Emit a companion
      // done-task for the achievement so it surfaces. It commits with the decision and inbox
      // status, so a retry can never observe or duplicate a half-filed mixed capture.
      if (completionSignal(text)) {
        const doneTitle = completionTitle(text) || firstLine;
        const { id: taskId } = await upsertTask({
          title: doneTitle,
          body: `${text}\n\n[split from decision ${id}: completed-work portion of a mixed capture]`,
          status: "done",
          createdBy: actor,
          source: "capture",
          derivedFrom: inboxId,
        });
        await indexParent("task", taskId, text, doneTitle, 1, INDEX_OPTIONS);
        await logEvent({
          actor: ACTOR,
          verb: "inbox:split-done-task",
          entityType: "inbox_item",
          entityId: inboxId,
          payload: auditPayload.inboxSplitDoneTask({ decisionId: id, taskId }),
        });
      }
      return { primary: ["decisions", id] };
    }
    case "note": {
      // notes become brain pages so they live in the markdown archive (I4). Agent-session
      // captures (SessionEnd hook) carry verbatim prompt/outcome text from arbitrary
      // projects, so they file at tier 2 like journal/interactions — searchable, but
      // reads stay behind the unlock gate (§12; invariant-review 2026-06-12). A caller may
      // pin an explicit tier via c.fields.tier (minime_refile, W2-3), but c.fields is not a
      // trusted channel by itself: the automatic pipeline passes classify()'s raw parsed JSON
      // straight through (classify.ts), and a replayed storedClassification is equally
      // unsanitized, so a stray or prompt-injected "tier" in the model's own JSON output must
      // never be able to UNDERCUT the text's own hint-based floor (BLOCKER, invariant-review
      // 2026-08-08). Floor whatever tier the fields carry (or the ordinary tier-1 default when
      // absent) against noteHintTier(text) so a pin can only ever RAISE the tier — it can raise
      // an ordinary note to tier 2 (minime_refile's floored override), but can never launder an
      // agent-session capture down to tier 1.
      const pinned = c.fields.tier === 1 || c.fields.tier === 2 ? c.fields.tier : 1;
      const tier = Math.max(pinned, noteHintTier(text)) as 1 | 2;
      const projection = noteProjection(c, text, inboxId);
      const relPath = relative(join(config.dataDir, "brain"), projection.absolutePath);
      const hash = sha256(projection.body);
      const { id } = await upsertPage({
        path: relPath,
        title: c.fields.title || firstLine,
        bodyMd: projection.body,
        contentHash: hash,
        createdBy: actor,
        source: "capture",
        derivedFrom: inboxId,
        tier,
      });
      await indexParent(
        "page",
        id,
        projection.body,
        c.fields.title || firstLine,
        tier,
        INDEX_OPTIONS,
      );
      return { primary: ["pages", id], projection };
    }
    default:
      return null;
  }
}

async function reconcileFiledProjection(item: InboxItem, bytes: Uint8Array): Promise<void> {
  if (item.status !== "filed" || item.filed_table !== "pages") return;
  const c = storedClassification(item.classifier_output);
  if (!c || c.type !== "note") return;
  await publishNoteProjection(noteProjection(c, Buffer.from(bytes).toString("utf8"), item.id));
}

async function processInboxSnapshot(
  item: InboxItem,
  bytes: Uint8Array,
): Promise<{ inboxId: string; filed: boolean }> {
  if (!item.content_hash || sha256(bytes) !== item.content_hash)
    throw new Error("inbox_snapshot_hash_mismatch");

  const claim = await claimInboxItem(item.id);
  if (!claim) {
    const current = await getInboxItem(item.id);
    if (!current) throw new Error("inbox_item_missing");
    await verifyOrHealStoredArchive(current, bytes);
    await reconcileFiledProjection(current, bytes);
    return { inboxId: current.id, filed: current.status === "filed" };
  }

  try {
    await archiveSnapshot(claim.item, claim.token, bytes);
    const text = Buffer.from(bytes).toString("utf8");
    let c = storedClassification(claim.item.classifier_output);
    if (!c) {
      c = await classify(text);
      // Persist the model plan under the fenced claim before finalization. If the process dies,
      // a stale claimant reuses the same plan instead of asking the model to segment differently.
      await setInboxClassification(item.id, claim.token, c);
    }

    const outcome = await withDbTransaction(async () => {
      await assertInboxClaim(item.id, claim.token);
      if (c.confidence >= CONFIDENCE_FLOOR && c.type !== "unknown") {
        const result = await fileRow(c, text, item.id);
        if (result === "duplicate") {
          // fileRow already queued a duplicate review item in this transaction.
          await setInboxPendingClaimed(item.id, claim.token, c);
          return { filed: false } as const;
        }
        if (result) {
          const [filedTable, filedId] = result.primary;
          await setInboxFiledClaimed(item.id, claim.token, filedTable, filedId, c);
          await logEvent({
            actor: ACTOR,
            verb: "inbox:filed",
            entityType: "inbox_item",
            entityId: item.id,
            payload: auditPayload.inboxFiled({
              kind: c.type,
              confidence: c.confidence,
              filedTable,
              filedId,
            }),
          });
          return { filed: true, projection: result.projection } as const;
        }
      }

      await setInboxPendingClaimed(item.id, claim.token, c);
      await insertReviewItem("inbox_unfiled", { inbox_item_id: item.id });
      await logEvent({
        actor: ACTOR,
        verb: "inbox:unfiled",
        entityType: "inbox_item",
        entityId: item.id,
        payload: auditPayload.inboxUnfiled({ kind: c.type, confidence: c.confidence }),
      });
      return { filed: false } as const;
    });

    // The Markdown mirror is a deterministic projection. Publishing only after the database
    // commit guarantees that a rolled-back finalization leaves no visible note derivative;
    // replay heals a post-commit publication failure.
    if (outcome.projection) await publishNoteProjection(outcome.projection);
    if (outcome.filed) await drainEmbedBacklog(64).catch(() => {});
    return { inboxId: item.id, filed: outcome.filed };
  } catch (error) {
    // A normal failure becomes immediately reclaimable; an actual process crash leaves the
    // timestamp untouched and is reclaimed after the lease expires. The token fences late work.
    await markInboxClaimRetryable(item.id, claim.token).catch(() => {});
    throw error;
  }
}

export async function processInboxFile(path: string): Promise<{ inboxId: string; filed: boolean }> {
  const snapshot = await readInboxSource(path);
  return processInboxSourceSnapshot(snapshot);
}

async function processInboxSourceSnapshot(snapshot: {
  path: string;
  bytes: Buffer;
}): Promise<{ inboxId: string; filed: boolean }> {
  const contentHash = sha256(snapshot.bytes);
  const item = await ensureInboxItemIdentity({
    rawPath: snapshot.path,
    contentHash,
    mime: extname(snapshot.path).toLowerCase() === ".md" ? "text/markdown" : "text/plain",
    createdBy: ACTOR,
    source: "capture",
  });
  return processInboxSnapshot(item, snapshot.bytes);
}

async function rejectOrphan(item: InboxItem): Promise<void> {
  await withDbTransaction(async () => {
    const rejected = await rejectRetryableInboxItem(
      item.id,
      "orphaned: immutable archive and matching source are unavailable",
    );
    if (!rejected) return;
    await logEvent({
      actor: ACTOR,
      verb: "inbox:orphaned",
      entityType: "inbox_item",
      entityId: item.id,
      payload: auditPayload.inboxOrphaned(),
    });
  });
  console.error(`[minime] inbox orphan rejected: ${basename(item.raw_path)} (snapshot missing)`);
}

async function recoverInboxItem(item: InboxItem): Promise<void> {
  if (item.content_hash) {
    // The archive filename is deterministic from the inbox identity. A process may die after the
    // no-replace publication but before archive_path commits; probe that exact path as well so the
    // immutable bytes remain recoverable even if the mutable source has since changed.
    const recoveryArchivePath = item.archive_path ?? archiveRelativePath(item);
    let bytes: Buffer | undefined;
    try {
      bytes = await readPrivateFile(recoveryArchivePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (bytes) {
      if (sha256(bytes) !== item.content_hash) throw new Error("inbox_archive_hash_mismatch");
      // Processing is outside the archive-read catch: an ENOENT from any later dependency must
      // propagate and keep this verified immutable snapshot retryable.
      await processInboxSnapshot(item, bytes);
      return;
    }
  }

  let source: Awaited<ReturnType<typeof readInboxSource>>;
  try {
    source = await readInboxSource(item.raw_path);
  } catch (error) {
    // Absence and a structurally impossible cross-root/symlink source are permanent for this row.
    // Permission and other transient read failures remain retryable owner data.
    const permanentlyUnavailable =
      (error as NodeJS.ErrnoException).code === "ENOENT" ||
      (error instanceof Error && error.message === "inbox_source_invalid");
    if (!permanentlyUnavailable) throw error;
    await rejectOrphan(item);
    return;
  }
  if (item.content_hash && sha256(source.bytes) !== item.content_hash) {
    await rejectOrphan(item);
    return;
  }
  // Processing is deliberately outside the source-read catch: archive, classifier, and
  // finalization errors must propagate and remain retryable, including errors carrying ENOENT.
  if (item.content_hash) {
    await processInboxSnapshot(item, source.bytes);
  } else {
    const result = await processInboxSourceSnapshot(source);
    if (result.inboxId !== item.id) {
      await withDbTransaction(async () => {
        if (!(await rejectDuplicateLegacyInboxItem(item.id))) return;
        await logEvent({
          actor: ACTOR,
          verb: "inbox:legacy-duplicate",
          entityType: "inbox_item",
          entityId: item.id,
          payload: auditPayload.inboxLegacyDuplicate(),
        });
      });
    }
  }
}

async function recoverFiledNoteProjection(item: InboxItem): Promise<void> {
  if (item.archive_path && item.content_hash) {
    const bytes = await readPrivateFile(item.archive_path);
    if (sha256(bytes) !== item.content_hash) throw new Error("inbox_archive_hash_mismatch");
    await reconcileFiledProjection(item, bytes);
    return;
  }
  const source = await readInboxSource(item.raw_path);
  if (sha256(source.bytes) !== item.content_hash) throw new Error("inbox_snapshot_hash_mismatch");
  await reconcileFiledProjection(item, source.bytes);
}

async function drainRetryableInbox(): Promise<void> {
  for (const item of await retryableInboxItems()) {
    await recoverInboxItem(item).catch((err) => {
      console.error(
        `[minime] inbox recovery failed for ${basename(item.raw_path)}: ${err?.message ?? err}`,
      );
    });
  }
}

// Process stale claims and unclassified pending rows first, preferring their immutable archive,
// then scan every current inbox file. Exact identities make the deliberate overlap idempotent and
// ensure changed bytes at an already-known path are not skipped.
async function drainStartup(inboxDir: string): Promise<void> {
  for (const item of await filedInboxNoteItems()) {
    await recoverFiledNoteProjection(item).catch((err) => {
      console.error(
        `[minime] inbox note recovery failed for ${basename(item.raw_path)}: ${err?.message ?? err}`,
      );
    });
  }
  await drainRetryableInbox();

  let entries: Dirent<string>[];
  try {
    entries = await readdir(inboxDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isFile() || entry.name.startsWith(".") || entry.name.endsWith("~")) continue;
    const path = join(inboxDir, entry.name);
    await processInboxFile(path).catch((err) => {
      console.error(`[minime] inbox drain failed for ${basename(path)}: ${err?.message ?? err}`);
    });
  }
}

export async function startWatcher(): Promise<{ close: () => Promise<void> }> {
  const inboxDir = join(config.dataDir, "inbox");
  await preflightPrivateRoot(config.dataDir, inboxDir, { create: true, mode: 0o700 });

  let accepting = true;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let retrySweep: Promise<void> | undefined;
  let armChain = Promise.resolve();
  const inFlight = new Set<Promise<void>>();
  const pathTail = new Map<string, Promise<void>>();
  const armRetrySweep = (): Promise<void> => {
    armChain = armChain
      .then(async () => {
        if (!accepting) return;
        if (retryTimer) clearTimeout(retryTimer);
        retryTimer = undefined;
        const retryAt = await nextInboxClaimExpiry();
        if (!accepting || !retryAt) return;
        const untilExpiry = retryAt.getTime() - Date.now() + 50;
        // A repeatedly failing stale item must not create a zero-delay recovery loop.
        const delay = untilExpiry > 0 ? untilExpiry : RETRY_BACKOFF_MS;
        retryTimer = setTimeout(
          () => {
            retryTimer = undefined;
            if (!accepting) return;
            retrySweep = drainRetryableInbox()
              .catch((err) => {
                console.error(`[minime] inbox retry sweep failed: ${err?.message ?? err}`);
              })
              .finally(() => {
                retrySweep = undefined;
                void armRetrySweep();
              });
          },
          Math.min(delay, 2_147_000_000),
        );
      })
      .catch((err) => {
        console.error(`[minime] inbox retry scheduling failed: ${err?.message ?? err}`);
        if (!accepting) return;
        retryTimer = setTimeout(() => {
          retryTimer = undefined;
          void armRetrySweep();
        }, RETRY_BACKOFF_MS);
      });
    return armChain;
  };
  const schedule = (path: string): void => {
    if (!accepting) return;
    const prior = pathTail.get(path) ?? Promise.resolve();
    const job = prior
      .catch(() => {})
      .then(() => processInboxFile(path))
      .then(() => {})
      .catch((err) => {
        console.error(
          `[minime] inbox processing failed for ${basename(path)}: ${err?.message ?? err}`,
        );
        void armRetrySweep();
      })
      .finally(() => {
        inFlight.delete(job);
        if (pathTail.get(path) === job) pathTail.delete(path);
      });
    pathTail.set(path, job);
    inFlight.add(job);
  };

  const watcher = chokidar.watch(inboxDir, {
    ignored: /(^|\/)\.|~$/,
    persistent: true,
    awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
    ignoreInitial: true,
  });
  watcher.on("add", schedule);
  watcher.on("change", schedule);
  await new Promise<void>((ready, reject) => {
    watcher.once("ready", ready);
    watcher.once("error", reject);
  });

  // Handlers are live before the scan, so a file arriving during startup is either observed by
  // Chokidar or the drain (often both, safely). There is no drain→watch admission gap.
  await drainStartup(inboxDir);
  await armRetrySweep();
  console.error(`[minime] watching ${inboxDir}`);
  return {
    close: async () => {
      accepting = false;
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = undefined;
      await watcher.close();
      await armChain;
      if (retrySweep) await retrySweep;
      await Promise.allSettled([...inFlight]);
    },
  };
}
