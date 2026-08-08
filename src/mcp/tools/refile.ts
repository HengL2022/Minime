// W2-3: minime_refile lets the owner manually file a pending inbox capture (one the automatic
// classifier left in the review queue, or hasn't reached yet) into a typed row, reusing the
// exact same fileRow/claim machinery the watcher itself uses (DECISIONS.md 2026-08-06 fenced
// finalization).
//
// Anti-laundering (binding cross-check): a pending capture's free text is tier-2-gated exactly
// like the review-queue read path, regardless of what the classifier guessed (DECISIONS.md
// 2026-08-08) — so refiling requires an active tier-2 unlock for the calling session. Beyond
// that entry gate, the capture's own stored classifier evidence (or an agent-session hint in the
// text itself) sets a floor that EVERY destination type is checked against, not only note: a
// "note" tier override can only raise that floor, never lower it, and type=task/decision are
// rejected outright whenever the floor is 2 — neither `tasks` nor `decisions` has an
// owner-facing tier-2 pathway through this tool, so there is no lower-tier-but-still-safe
// override to fall back to; filing at their permanent tier-1 default would launder tier-2-grade
// text into content any actor can read forever without ever unlocking anything. journal and
// interaction need no such check: fileRow always files them at tier 2 regardless of any
// override, so they can never be the laundering channel. The floor is computed from the row's
// state AT CLAIM TIME (claim.item, from claimPendingInboxItemForRefile's UPDATE ... RETURNING),
// never from the plain read at the top of this handler — every query here runs READ COMMITTED
// (see the claim's own independent transaction below), so a concurrent classifier pass that
// commits in the gap between that read and the claim is visible to the claim but must not be
// allowed to leave a stale, weaker evidence value already baked into the floor.

import { z } from "zod";
import {
  allowedTier,
  assertInboxClaim,
  claimPendingInboxItemForRefile,
  getInboxItem,
  logEvent,
  resolveOpenReviewItemsForInbox,
  setInboxFiledClaimed,
  withActorDurableDbSession,
} from "../../db/repo";
import type { Classification } from "../../pipeline/classify";
import {
  type FiledTable,
  type NoteProjection,
  fileRow,
  noteHintTier,
  publishNoteProjection,
  readArchivedCapture,
  storedClassification,
} from "../../pipeline/watcher";
import { auditPayload } from "../../util/audit-payload";
import { ToolError, envelope } from "../envelope";
import type { ToolDef } from "./registry";

const REFILE_TYPE = ["task", "journal", "note", "interaction", "decision"] as const;
type RefileType = (typeof REFILE_TYPE)[number];

// Owner-facing refile type -> the Classification type fileRow's switch expects. "decision" maps
// to "decision_note" (fileRow/classify's internal name); every other name is shared verbatim.
const CLASSIFICATION_TYPE: Record<RefileType, Classification["type"]> = {
  task: "task",
  journal: "journal",
  note: "note",
  interaction: "interaction",
  decision: "decision_note",
};

// SourceRef.type per filed table: the singular parent-type name other tools already use
// (upsertTaskTool -> "task", journalTool -> "journal", ...), not the raw SQL table name.
const SOURCE_TYPE: Record<FiledTable, string> = {
  tasks: "task",
  journal_entries: "journal",
  interactions: "interaction",
  pages: "page",
  decisions: "decision",
};

// The classifier guess stored on the inbox item is metadata the caller can already see without
// unlocking anything (review-queue convention, DECISIONS.md 2026-08-08). journal/interaction are
// the two types that always file at tier 2 (insertJournal/insertInteraction default tier=2), so a
// stored guess of either is positive evidence this capture's free text is tier-2-grade — the
// floor every refile destination is checked against (see file header): a "note" tier override may
// never go below it, and type=task/decision are rejected outright when it's 2. Any other guess
// (or none yet) carries no such evidence, so the floor stays at the ordinary tier-1 default.
function evidenceFloor(stored: Classification | null): 1 | 2 {
  return stored?.type === "journal" || stored?.type === "interaction" ? 2 : 1;
}

interface TransactionOutcome {
  filedTable: FiledTable;
  filedId: string;
  resolved: string[];
  projection?: NoteProjection;
}

export const refileTool: ToolDef = {
  name: "minime_refile",
  description:
    "File a pending inbox capture (status=pending) into a typed row: task | journal | note | " +
    "interaction | decision. Requires an approved tier-2 unlock (minime_unlock) — a not-yet-" +
    "filed capture's text is tier-2-gated regardless of its eventual type (DECISIONS.md " +
    "2026-08-08). Optional overrides: title, due (YYYY-MM-DD), person_name, kind " +
    "(meeting|call|message|email|note), question, choice, mood (1-5), and tier (1|2 — honored " +
    "only when type=note, and floored to 2 whenever this capture's own stored classifier guess " +
    "was journal/interaction, so tier-2-grade text can never be filed as a lower-tier note). " +
    "type=task/decision are rejected (BAD_INPUT) instead of downgraded when that same evidence " +
    "says tier-2: neither table has a tier-2 representation, so file it as journal, " +
    "interaction, or note (tier 2) instead. Rejects a non-pending item, and rejects a match " +
    "against an existing open task (BAD_INPUT) rather than filing a duplicate. Resolves any " +
    "open inbox_unfiled/duplicate review-queue items for this capture. Never echoes the " +
    "capture's text back in its response.",
  schema: {
    inbox_item_id: z.string().uuid(),
    type: z.enum(REFILE_TYPE),
    title: z.string().min(1).optional(),
    due: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    person_name: z.string().min(1).optional(),
    kind: z.enum(["meeting", "call", "message", "email", "note"]).optional(),
    question: z.string().min(1).optional(),
    choice: z.string().optional(),
    mood: z.number().int().min(1).max(5).optional(),
    tier: z.union([z.literal(1), z.literal(2)]).optional(),
  },
  handler: async (params, ctx) => {
    const item = await getInboxItem(params.inbox_item_id);
    if (!item) throw new ToolError("NOT_FOUND", "inbox item not found");
    if (item.status !== "pending") {
      throw new ToolError("BAD_INPUT", "already filed — use minime_correct to amend the filed row");
    }
    // Anti-laundering gate: see file header. Applies regardless of the requested target type —
    // reading the archive below is itself the disclosure this gate protects.
    if ((await allowedTier(ctx.actor)) !== 2) {
      throw new ToolError(
        "BAD_INPUT",
        "refiling requires an approved tier-2 unlock (minime_unlock) — this capture's text is " +
          "tier-2-gated until filed",
      );
    }
    const text = await readArchivedCapture(item);
    if (text === null) throw new ToolError("NOT_FOUND", "capture archive unavailable");

    const type = CLASSIFICATION_TYPE[params.type as RefileType];
    const fields: Record<string, unknown> = {};
    if (params.title !== undefined) fields.title = params.title;
    if (params.due !== undefined) fields.due = params.due;
    if (params.person_name !== undefined) fields.person_name = params.person_name;
    if (params.kind !== undefined) fields.kind = params.kind;
    if (params.question !== undefined) fields.question = params.question;
    if (params.choice !== undefined) fields.choice = params.choice;
    if (params.mood !== undefined) fields.mood = params.mood;

    // A tool handler runs inside ONE ambient actor transaction (executeTool -> withActorDbSession)
    // for its whole call, so an ordinary withDbTransaction here would be reentrant, not a separate
    // commit boundary: its "commit" would only actually happen once this whole handler resolves —
    // i.e. AFTER any publish call made before returning, not before it. withActorDurableDbSession
    // (repo.ts) always opens a genuinely fresh transaction on its own connection regardless of the
    // ambient scope — the same withDurableRuntimeDbTransaction primitive capture.ts already uses
    // for "commit for real before a filesystem write" — so it actually commits the instant this
    // callback returns, strictly before publishNoteProjection runs below. It carries the same
    // minime.actor/minime.session_id GUCs withActorDbSession set on the ambient transaction, so
    // app_allowed_tier() (the tier predicate every claim/assert/setFiled call below appends) sees
    // the identical tier-2-unlock state either way. A duplicate match still throws immediately
    // (below fileRow's call, inside this block) — there is no way to keep fileRow's queued
    // duplicate review item while still failing the overall call, so this transaction's own
    // rollback undoes the claim along with it, leaving the item exactly as it was — the ambient
    // transaction never held any of this work, so it has nothing to undo. The standard
    // tool:minime_refile:result audit event (I8) still records the attempt on its own separate
    // durable connection, independent of either transaction.
    const outcome = await withActorDurableDbSession<TransactionOutcome>(
      ctx.actor,
      async () => {
        // claimPendingInboxItemForRefile (not claimInboxItem) so a concurrent watcher replay OR a
        // second concurrent refile call is fenced exactly like the automatic pipeline, even though
        // this item was already classified (claimInboxItem's 'pending' branch deliberately excludes
        // that case — see its repo.ts doc comment).
        const claim = await claimPendingInboxItemForRefile(item.id);
        if (!claim) {
          throw new ToolError(
            "BAD_INPUT",
            "capture is currently claimed by another process — retry shortly",
          );
        }
        await assertInboxClaim(item.id, claim.token);

        // Anti-laundering floor + gate (see file header): computed from claim.item, the row
        // exactly as claimPendingInboxItemForRefile's UPDATE ... RETURNING just observed it — never
        // from the plain read at the top of this handler, which a concurrent classifier pass could
        // have raced past. task/decision are rejected outright above the floor; note is floored,
        // never lowered; journal/interaction always file at tier 2 regardless (no check needed).
        const floor = Math.max(
          evidenceFloor(storedClassification(claim.item.classifier_output)),
          noteHintTier(text),
        ) as 1 | 2;
        if (floor === 2 && (type === "task" || type === "decision_note")) {
          throw new ToolError(
            "BAD_INPUT",
            "this capture's own stored evidence indicates tier-2-grade content — file it as " +
              "journal, interaction, or note (tier 2) instead; task/decision have no tier-2 " +
              "representation",
          );
        }
        if (type === "note") {
          fields.tier = params.tier !== undefined ? Math.max(params.tier, floor) : floor;
        }

        const classification: Classification = {
          type,
          confidence: 1,
          fields,
          reason: "owner refile",
        };

        // I5 provenance: attribute the filed row — and any org/person/companion row it creates —
        // to the real MCP caller, not fileRow's ACTOR default, which is only correct for the
        // watcher's own automatic-pipeline callers (fileRow's doc comment, watcher.ts).
        const result = await fileRow(classification, text, item.id, ctx.actor);
        if (result === "duplicate") {
          throw new ToolError(
            "BAD_INPUT",
            "this capture matches an existing open task — file it as a different type, or " +
              "resolve the match first",
          );
        }
        if (!result) {
          // Unreachable: CLASSIFICATION_TYPE only emits types fileRow's switch recognizes.
          throw new Error("refile_unfileable_type");
        }
        const [filedTable, filedId] = result.primary;
        await setInboxFiledClaimed(item.id, claim.token, filedTable, filedId, classification);
        const resolved = await resolveOpenReviewItemsForInbox(item.id);
        await logEvent({
          actor: ctx.actor,
          verb: "inbox:refiled",
          entityType: "inbox_item",
          entityId: item.id,
          payload: auditPayload.inboxRefiled({ type: classification.type, filedTable, filedId }),
        });
        return { filedTable, filedId, resolved, projection: result.projection };
      },
      ctx.sessionId,
    );

    // Only reachable once the independent transaction above has genuinely committed (see the
    // comment there), exactly like processInboxSnapshot: a rolled-back finalization must never
    // leave a visible projection. A crash between that commit and here just leaves a filed row
    // with no markdown mirror yet — the same residual risk processInboxSnapshot already accepts
    // for the automatic pipeline.
    if (outcome.projection) await publishNoteProjection(outcome.projection);

    return envelope(
      {
        filed_table: outcome.filedTable,
        filed_id: outcome.filedId,
        resolved_review_items: outcome.resolved,
      },
      [
        { type: SOURCE_TYPE[outcome.filedTable], id: outcome.filedId },
        { type: "inbox_item", id: item.id },
      ],
    );
  },
};
