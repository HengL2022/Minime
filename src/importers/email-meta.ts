// Maildir importer: headers only (From, Date, Subject, Message-ID, thread). Bodies are
// never stored in v1 (spec §10). Idempotent on message_id.

import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { logEvent, upsertEmailMeta } from "../db/repo";
import type { ImportStats } from "./calendar";

export function parseHeaders(raw: string): Map<string, string> {
  const headerPart = raw.split(/\r?\n\r?\n/)[0] ?? "";
  const headers = new Map<string, string>();
  let curKey: string | null = null;
  for (const line of headerPart.split(/\r?\n/)) {
    if (/^[ \t]/.test(line) && curKey) {
      headers.set(curKey, `${headers.get(curKey)} ${line.trim()}`);
      continue;
    }
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    curKey = line.slice(0, idx).toLowerCase();
    headers.set(curKey, line.slice(idx + 1).trim());
  }
  return headers;
}

export function extractAddr(from: string): string {
  const m = from.match(/<([^>]+)>/);
  return (m ? m[1]! : from).trim();
}

export async function importEmailFile(raw: string, stats: ImportStats): Promise<void> {
  stats.total++;
  const h = parseHeaders(raw);
  const messageId = h.get("message-id")?.replace(/[<>]/g, "");
  const dateRaw = h.get("date");
  const from = h.get("from");
  const date = dateRaw ? new Date(dateRaw) : null;
  if (!messageId || !from || !date || Number.isNaN(date.getTime())) {
    stats.skipped++;
    await logEvent({
      actor: "importer:email-meta",
      verb: "import:malformed",
      payload: { reason: "missing message-id/from/date" },
    });
    return;
  }
  // thread: prefer References root, else In-Reply-To, else own id
  const refs = h.get("references")?.match(/<([^>]+)>/);
  const inReplyTo = h.get("in-reply-to")?.match(/<([^>]+)>/);
  const threadId = refs?.[1] ?? inReplyTo?.[1] ?? messageId;
  const inserted = await upsertEmailMeta({
    messageId,
    at: date,
    fromAddr: extractAddr(from),
    subject: h.get("subject") ?? null,
    threadId,
  });
  if (inserted) stats.inserted++;
  else stats.updated++;
}

export async function importEmailMeta(maildirPath: string): Promise<ImportStats> {
  const stats: ImportStats = { total: 0, inserted: 0, updated: 0, skipped: 0 };
  for (const sub of ["cur", "new"]) {
    const dir = join(maildirPath, sub);
    let files: string[] = [];
    try {
      files = await readdir(dir);
    } catch {
      continue; // missing cur/ or new/ is fine
    }
    for (const f of files.sort()) {
      if (f.startsWith(".")) continue;
      const raw = await Bun.file(join(dir, f)).text();
      await importEmailFile(raw, stats);
    }
  }
  await logEvent({
    actor: "importer:email-meta",
    verb: "import:email-meta",
    payload: stats as any,
  });
  return stats;
}
