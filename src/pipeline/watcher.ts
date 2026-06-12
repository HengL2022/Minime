// Inbox pipeline (spec §10): new file in data/inbox/ → archive copy → inbox_items row →
// classify → file the typed row (confidence ≥ 0.7) or queue for the evening review.

import { copyFile, mkdir } from "node:fs/promises";
import { basename, join } from "node:path";
import chokidar from "chokidar";
import {
  ensurePerson,
  findInboxByPath,
  insertDecision,
  insertInboxItem,
  insertInteraction,
  insertJournal,
  insertReviewItem,
  logEvent,
  setInboxFiled,
  setInboxPending,
  upsertPage,
  upsertTask,
} from "../db/repo";
import { indexParent } from "../search/index-parent";
import { now, todayStr } from "../util/clock";
import { config } from "../util/config";
import { type Classification, classify } from "./classify";

const ACTOR = "agent:classifier";
const CONFIDENCE_FLOOR = 0.7;

async function archiveCopy(path: string): Promise<string> {
  const t = now();
  const dir = join(
    config.dataDir,
    "archive",
    String(t.getFullYear()),
    String(t.getMonth() + 1).padStart(2, "0"),
  );
  await mkdir(dir, { recursive: true });
  const dest = join(dir, basename(path));
  await copyFile(path, dest);
  return dest;
}

// Insert the typed row for a classification; returns [table, id] or null when unfileable.
async function fileRow(
  c: Classification,
  text: string,
  inboxId: string,
): Promise<[string, string] | null> {
  const firstLine = text
    .split("\n")[0]!
    .replace(/^<!--.*?-->\s*/s, "")
    .trim()
    .slice(0, 200);
  switch (c.type) {
    case "task": {
      const { id } = await upsertTask({
        title: c.fields.title || firstLine,
        body: text,
        due:
          typeof c.fields.due === "string" && /^\d{4}-\d{2}-\d{2}$/.test(c.fields.due)
            ? c.fields.due
            : null,
        createdBy: ACTOR,
        source: "capture",
        derivedFrom: inboxId,
      });
      await indexParent("task", id, text, c.fields.title || firstLine, 1);
      return ["tasks", id];
    }
    case "journal": {
      const { id } = await insertJournal({
        entryMd: text,
        mood: typeof c.fields.mood === "number" ? c.fields.mood : null,
        createdBy: ACTOR,
        source: "capture",
        derivedFrom: inboxId,
      });
      await indexParent("journal", id, text, `Journal ${todayStr()}`, 2);
      return ["journal_entries", id];
    }
    case "interaction": {
      const person = await ensurePerson(c.fields.person_name || "Unknown", ACTOR);
      const kind = ["meeting", "call", "message", "email", "note"].includes(c.fields.kind)
        ? c.fields.kind
        : "note";
      const { id } = await insertInteraction({
        personId: person.id,
        kind,
        summary: text,
        createdBy: ACTOR,
        source: "capture",
        derivedFrom: inboxId,
      });
      await indexParent("interaction", id, text, undefined, 2);
      return ["interactions", id];
    }
    case "decision_note": {
      const { id } = await insertDecision({
        question: c.fields.question || firstLine,
        options: Array.isArray(c.fields.options) ? c.fields.options : [],
        choice: typeof c.fields.choice === "string" ? c.fields.choice : null,
        reasoning: text,
        createdBy: ACTOR,
        source: "capture",
        derivedFrom: inboxId,
      });
      await indexParent("decision", id, text, firstLine, 1);
      return ["decisions", id];
    }
    case "note": {
      // notes become brain pages so they live in the markdown archive (I4). Agent-session
      // captures (SessionEnd hook) carry verbatim prompt/outcome text from arbitrary
      // projects, so they file at tier 2 like journal/interactions — searchable, but
      // reads stay behind the unlock gate (§12; invariant-review 2026-06-12).
      const tier = /<!-- hint: agent work session -->/.test(text) ? 2 : 1;
      const slug =
        (c.fields.title || firstLine)
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-|-$/g, "")
          .slice(0, 60) || `note-${inboxId.slice(0, 8)}`;
      const relPath = `inbox/${slug}.md`;
      const absPath = join(config.dataDir, "brain", relPath);
      await mkdir(join(config.dataDir, "brain", "inbox"), { recursive: true });
      const body = `# ${c.fields.title || firstLine}\n\n${text}`;
      await Bun.write(absPath, body);
      const hash = new Bun.CryptoHasher("sha256").update(body).digest("hex");
      const { id } = await upsertPage({
        path: relPath,
        title: c.fields.title || firstLine,
        bodyMd: body,
        contentHash: hash,
        createdBy: ACTOR,
        source: "capture",
        derivedFrom: inboxId,
        tier,
      });
      await indexParent("page", id, body, c.fields.title || firstLine, tier);
      return ["pages", id];
    }
    default:
      return null;
  }
}

export async function processInboxFile(path: string): Promise<{ inboxId: string; filed: boolean }> {
  await archiveCopy(path);
  const existing = await findInboxByPath(path);
  const inboxId: string =
    existing?.id ?? (await insertInboxItem({ rawPath: path, createdBy: ACTOR })).id;
  if (existing && existing.status !== "pending")
    return { inboxId, filed: existing.status === "filed" };

  const text = await Bun.file(path).text();
  const c = await classify(text);
  if (c.confidence >= CONFIDENCE_FLOOR && c.type !== "unknown") {
    const filed = await fileRow(c, text, inboxId);
    if (filed) {
      await setInboxFiled(inboxId, filed[0], filed[1], c);
      await logEvent({
        actor: ACTOR,
        verb: "inbox:filed",
        entityType: "inbox_item",
        entityId: inboxId,
        payload: {
          type: c.type,
          confidence: c.confidence,
          filed_table: filed[0],
          filed_id: filed[1],
        },
      });
      return { inboxId, filed: true };
    }
  }
  await setInboxPending(inboxId, c);
  await insertReviewItem("inbox_unfiled", {
    inbox_item_id: inboxId,
    raw_path: path,
    classifier: c,
  });
  await logEvent({
    actor: ACTOR,
    verb: "inbox:unfiled",
    entityType: "inbox_item",
    entityId: inboxId,
    payload: { type: c.type, confidence: c.confidence },
  });
  return { inboxId, filed: false };
}

export function startWatcher(): { close: () => Promise<void> } {
  const inboxDir = join(config.dataDir, "inbox");
  const watcher = chokidar.watch(inboxDir, {
    ignored: /(^|\/)\./,
    persistent: true,
    awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
    ignoreInitial: false, // process files that arrived while we were down
  });
  watcher.on("add", (path) => {
    processInboxFile(path).catch((err) => {
      console.error(
        `[minime] inbox processing failed for ${basename(path)}: ${err?.message ?? err}`,
      );
    });
  });
  console.error(`[minime] watching ${inboxDir}`);
  return { close: () => watcher.close() };
}
