// Brain sync (spec §10): data/brain/**/*.md → pages (+ chunks). Frontmatter: title, tier?,
// status?. Hash-diff upserts; files removed from disk are soft-deleted (rows stay, I4).

import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { listActivePages, replaceChunks, softDeletePagesNotIn, upsertPage } from "../db/repo";
import { indexParent } from "../search/index-parent";
import { config } from "../util/config";

export interface Frontmatter {
  title?: string;
  tier?: number;
  status?: string;
  body: string;
}

export function parseFrontmatter(md: string): Frontmatter {
  const m = md.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { body: md };
  const out: Frontmatter = { body: md.slice(m[0].length) };
  for (const line of m[1]!.split(/\r?\n/)) {
    const kv = line.match(/^(\w+):\s*(.*)$/);
    if (!kv) continue;
    const [, key, raw] = kv;
    const value = raw!.trim().replace(/^["']|["']$/g, "");
    if (key === "title") out.title = value;
    if (key === "tier" && /^[012]$/.test(value)) out.tier = Number(value);
    if (key === "status") out.status = value;
  }
  return out;
}

function titleFrom(fm: Frontmatter, relPath: string): string {
  if (fm.title) return fm.title;
  const h1 = fm.body.match(/^#\s+(.+)$/m);
  if (h1) return h1[1]!.trim();
  return relPath.replace(/\.md$/, "").split("/").pop()!;
}

async function walkMd(dir: string, base: string): Promise<string[]> {
  const out: string[] = [];
  let entries: import("node:fs").Dirent[];
  try {
    entries = (await readdir(dir, { withFileTypes: true })) as any;
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name.startsWith(".")) continue; // .git etc.
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walkMd(full, base)));
    else if (e.name.endsWith(".md")) out.push(full);
  }
  return out;
}

export interface SyncStats {
  scanned: number;
  changed: number;
  unchanged: number;
  deleted: number;
}

export async function brainSync(): Promise<SyncStats> {
  const brainDir = join(config.dataDir, "brain");
  const files = await walkMd(brainDir, brainDir);
  const stats: SyncStats = { scanned: 0, changed: 0, unchanged: 0, deleted: 0 };
  const seenPaths: string[] = [];

  for (const file of files) {
    const relPath = relative(brainDir, file);
    const raw = await Bun.file(file).text();
    const fm = parseFrontmatter(raw);
    if (fm.status === "deleted") continue; // treat as absent → soft-delete below
    stats.scanned++;
    seenPaths.push(relPath);
    const hash = new Bun.CryptoHasher("sha256").update(raw).digest("hex");
    const tier = fm.tier ?? 1;
    const { id, changed } = await upsertPage({
      path: relPath,
      title: titleFrom(fm, relPath),
      bodyMd: fm.body,
      contentHash: hash,
      tier,
      source: "brain-sync",
    });
    if (changed) {
      await indexParent("page", id, fm.body, titleFrom(fm, relPath), tier);
      stats.changed++;
    } else {
      stats.unchanged++;
    }
  }

  const deletedIds = await softDeletePagesNotIn(seenPaths);
  for (const id of deletedIds) {
    await replaceChunks("page", id, [], 1); // drop chunks of deleted pages from the index
  }
  stats.deleted = deletedIds.length;
  return stats;
}

// re-export for callers that only need page listing alongside sync
export { listActivePages };
