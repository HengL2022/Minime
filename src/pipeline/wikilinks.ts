// Path-based [[wikilink]] resolver. Pages have no alias table — resolution is
// slug/path only, never title. Title-shaped targets (`[[Ingrid Solberg]]`)
// return null so a later title index cannot silently change meaning.

import { pagesByEntityUuidSuffix, pagesByPaths } from "../db/repo";

const WIKILINK_RE = /\[\[([^[\]]+)\]\]/g;
const SLUG_UUID_RE =
  /^[a-z0-9-]+--([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

export type WikilinkNorm = { kind: "path"; value: string } | { kind: "slug"; value: string };

export interface ResolvedWikilink {
  target: string;
  path: string;
  id: string;
}

export function parseWikilinks(body: string): string[] {
  const out: string[] = [];
  for (const match of body.matchAll(WIKILINK_RE)) {
    const raw = match[1]!.trim();
    if (raw) out.push(raw);
  }
  return out;
}

export function normalizeWikilinkTarget(raw: string): WikilinkNorm | null {
  const target = raw.trim();
  if (!target || target.includes("\n") || target.includes("[[") || target.includes("]]")) {
    return null;
  }
  if (target.includes("/") || target.endsWith(".md")) {
    const path = target.endsWith(".md") ? target : `${target}.md`;
    if (path.startsWith("/") || path.includes("..") || path.includes("\\")) return null;
    return { kind: "path", value: path };
  }
  const slug = target.match(SLUG_UUID_RE);
  if (!slug) return null;
  return { kind: "slug", value: slug[1]!.toLowerCase() };
}

export async function resolveWikilinkTargets(targets: string[]): Promise<ResolvedWikilink[]> {
  const paths: string[] = [];
  const uuids: string[] = [];
  const pending: { target: string; norm: WikilinkNorm }[] = [];
  for (const target of targets) {
    const norm = normalizeWikilinkTarget(target);
    if (!norm) continue;
    pending.push({ target, norm });
    if (norm.kind === "path") paths.push(norm.value);
    else uuids.push(norm.value);
  }
  const [pathRows, slugRows] = await Promise.all([
    pagesByPaths(paths),
    pagesByEntityUuidSuffix(uuids),
  ]);
  const byPath = new Map(pathRows.map((row) => [row.path, row]));
  const byUuid = new Map(
    slugRows.map((row) => {
      const uuid = row.path.match(/--([0-9a-f-]{36})\.md$/i)?.[1]?.toLowerCase();
      return [uuid ?? "", row] as const;
    }),
  );
  const out: ResolvedWikilink[] = [];
  for (const { target, norm } of pending) {
    const row = norm.kind === "path" ? byPath.get(norm.value) : byUuid.get(norm.value);
    if (row) out.push({ target, path: row.path, id: row.id });
  }
  return out;
}
