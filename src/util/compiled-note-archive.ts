import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve } from "node:path";

export const COMPILED_NOTE_SOURCE = "dream:notes";
export const COMPILED_NOTE_CREATOR = "system:dream";
export const COMPILED_NOTE_MARKER =
  "*Compiled note — distilled by the dream job from the sources below. No new claims; verify against the cited source rows.*";
export const COMPILED_NOTE_UUID_PATH_SQL_RE =
  "^derived/notes/(person|org)/[^/]+--[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.md$";

export type CompiledNoteKind = "person" | "org";
export type NoteTier = 1 | 2;

export interface CompiledNoteIdentity {
  kind: CompiledNoteKind;
  entityId: string;
}

export interface CanonicalCompiledNoteArchive {
  title: string;
  tier: NoteTier;
  bodyMd: string;
  text: string;
  bytes: Uint8Array;
  contentHash: string;
}

export interface ParsedFrontmatter {
  title?: string;
  tier?: number;
  status?: string;
  source_file?: string;
  body: string;
}

export interface CompiledNoteRecognitionInput {
  path: string;
  source?: string | null;
  bodyMd: string;
}

export type CompiledNoteRecognition =
  | { recognized: false }
  | {
      recognized: true;
      reason: "source" | "uuid_path" | "system_shape";
      pathIdentity: CompiledNoteIdentity | null;
      sourceIds: string[];
    };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID_PATH_RE =
  /^derived\/notes\/(person|org)\/([a-z0-9-]+)--([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.md$/;

export function normalizeCompiledNoteBody(body: string): string {
  return body.replace(/\r\n?/g, "\n").replace(/\n+$/g, "");
}

function canonicalUuid(entityId: string): string {
  if (!UUID_RE.test(entityId) || entityId !== entityId.toLowerCase()) {
    throw new Error("INVALID_ENTITY_UUID");
  }
  return entityId;
}

export function compiledNotePath(
  kind: CompiledNoteKind,
  readableName: string,
  entityId: string,
): string {
  if (kind !== "person" && kind !== "org") throw new Error("INVALID_NOTE_KIND");
  const canonicalId = canonicalUuid(entityId);
  let slug = readableName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  if (!slug) slug = canonicalId;
  return `derived/notes/${kind}/${slug}--${canonicalId}.md`;
}

export function compiledNoteIdentityFromPath(path: string): CompiledNoteIdentity | null {
  const match = path.match(UUID_PATH_RE);
  if (!match) return null;
  return { kind: match[1] as CompiledNoteKind, entityId: match[3]!.toLowerCase() };
}

export function resolveCompiledNoteArchiveTarget(
  brainRoot: string,
  relativePath: string,
): string | null {
  if (!relativePath || isAbsolute(relativePath)) return null;
  const root = resolve(brainRoot);
  const target = resolve(root, relativePath);
  const remainder = relative(root, target);
  if (!remainder || isAbsolute(remainder) || remainder === ".." || remainder.startsWith("../")) {
    return null;
  }
  return target;
}

function parseScalar(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replace(/''/g, "'");
  }
  if (!trimmed.startsWith('"')) return trimmed;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return typeof parsed === "string" ? parsed : trimmed;
  } catch {
    if (trimmed.length >= 2 && trimmed.endsWith('"')) return trimmed.slice(1, -1);
    return trimmed.slice(1);
  }
}

function frontmatterParts(normalized: string): { header: string; body: string } | null {
  if (!normalized.startsWith("---\n")) return null;
  const delimited = normalized.indexOf("\n---\n", 4);
  if (delimited >= 0) {
    return {
      header: normalized.slice(4, delimited),
      body: normalized.slice(delimited + "\n---\n".length),
    };
  }
  if (normalized.endsWith("\n---")) {
    return { header: normalized.slice(4, -4), body: "" };
  }
  return null;
}

export type FrontmatterTierClassification =
  | { kind: "absent" }
  | { kind: "valid"; tier: 1 | 2 }
  | { kind: "tier0" }
  | { kind: "invalid" };

export function classifyFrontmatterTier(md: string): FrontmatterTierClassification {
  const normalized = md.replace(/\r\n?/g, "\n");
  const parts = frontmatterParts(normalized);
  if (!parts) return normalized.startsWith("---\n") ? { kind: "invalid" } : { kind: "absent" };
  let rawTier: string | undefined;
  for (const line of parts.header.split("\n")) {
    const match = line.match(/^tier:\s*(.*)$/);
    if (match) rawTier = parseScalar(match[1]!);
  }
  if (rawTier === undefined) return { kind: "absent" };
  if (rawTier === "0") return { kind: "tier0" };
  if (rawTier === "1" || rawTier === "2") {
    return { kind: "valid", tier: Number(rawTier) as 1 | 2 };
  }
  return { kind: "invalid" };
}

const SOURCE_FILE_RE = /^files\/\d{4}\/[a-f0-9]{64}\.[A-Za-z0-9.]{1,16}$/;

export function parseFrontmatterDocument(md: string): ParsedFrontmatter {
  const normalized = md.replace(/\r\n?/g, "\n");
  const parts = frontmatterParts(normalized);
  if (!parts) return { body: normalized };
  const out: ParsedFrontmatter = { body: parts.body };
  for (const line of parts.header.split("\n")) {
    const match = line.match(/^(title|tier|status|source_file):\s*(.*)$/);
    if (!match) continue;
    const key = match[1]!;
    const value = parseScalar(match[2]!);
    if (key === "title") out.title = value;
    else if (key === "status") out.status = value;
    else if (key === "source_file") {
      if (SOURCE_FILE_RE.test(value)) out.source_file = value;
    } else if (/^\d+$/.test(value)) out.tier = Number(value);
  }
  return out;
}

/** Capture-filed notes only. Compiled archives stay title+tier. Invalid paths are ignored. */
export function withSourceFileFrontmatter(body: string, sourceFile: string): string {
  if (!SOURCE_FILE_RE.test(sourceFile)) return body;
  const normalized = body.replace(/\r\n?/g, "\n");
  const parts = frontmatterParts(normalized);
  if (!parts) return `---\nsource_file: ${sourceFile}\n---\n${normalized}`;
  const kept = parts.header.split("\n").filter((line) => !/^source_file:\s*/.test(line) && line);
  kept.push(`source_file: ${sourceFile}`);
  return `---\n${kept.join("\n")}\n---\n${parts.body}`;
}

export function renderCompiledNoteArchive(input: {
  title: string;
  tier: NoteTier;
  bodyMd: string;
}): CanonicalCompiledNoteArchive {
  if (input.tier !== 1 && input.tier !== 2) throw new Error("INVALID_NOTE_TIER");
  const bodyMd = normalizeCompiledNoteBody(input.bodyMd);
  const text = `---\ntitle: ${JSON.stringify(input.title)}\ntier: ${input.tier}\n---\n${bodyMd}\n`;
  const bytes = new TextEncoder().encode(text);
  const contentHash = createHash("sha256").update(bytes).digest("hex");
  return { title: input.title, tier: input.tier, bodyMd, text, bytes, contentHash };
}

export function parseCompiledNoteArchive(md: string): CanonicalCompiledNoteArchive | null {
  const parsed = parseFrontmatterDocument(md);
  if (parsed.title === undefined || (parsed.tier !== 1 && parsed.tier !== 2)) return null;
  const rendered = renderCompiledNoteArchive({
    title: parsed.title,
    tier: parsed.tier as NoteTier,
    bodyMd: parsed.body,
  });
  const normalizedInput = md.replace(/\r\n?/g, "\n");
  return rendered.text === normalizedInput ? rendered : null;
}

export function parseCompiledNoteSourceIds(bodyMd: string): {
  hasSourcesHeading: boolean;
  ids: string[];
} {
  const lines = bodyMd.replace(/\r\n?/g, "\n").split("\n");
  const headingIndexes: number[] = [];
  lines.forEach((line, index) => {
    if (line === "## Sources") headingIndexes.push(index);
  });
  if (headingIndexes.length === 0) return { hasSourcesHeading: false, ids: [] };
  const start = headingIndexes[headingIndexes.length - 1]! + 1;
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const line of lines.slice(start)) {
    const match = line.match(/^- ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
    if (!match) continue;
    const id = match[1]!.toLowerCase();
    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  return { hasSourcesHeading: true, ids };
}

function hasSystemShape(bodyMd: string): { valid: boolean; sourceIds: string[] } {
  const normalized = bodyMd.replace(/\r\n?/g, "\n");
  const marker = normalized.split("\n").some((line) => line === COMPILED_NOTE_MARKER);
  const parsed = parseCompiledNoteSourceIds(normalized);
  return {
    valid: marker && parsed.hasSourcesHeading && parsed.ids.length > 0,
    sourceIds: parsed.ids,
  };
}

export function recognizeCompiledNote(page: CompiledNoteRecognitionInput): CompiledNoteRecognition {
  const pathIdentity = compiledNoteIdentityFromPath(page.path);
  if (page.source === COMPILED_NOTE_SOURCE) {
    return {
      recognized: true,
      reason: "source",
      pathIdentity,
      sourceIds: parseCompiledNoteSourceIds(page.bodyMd).ids,
    };
  }
  if (pathIdentity) {
    return {
      recognized: true,
      reason: "uuid_path",
      pathIdentity,
      sourceIds: parseCompiledNoteSourceIds(page.bodyMd).ids,
    };
  }
  const shape = hasSystemShape(page.bodyMd);
  if (shape.valid)
    return {
      recognized: true,
      reason: "system_shape",
      pathIdentity: null,
      sourceIds: shape.sourceIds,
    };
  return { recognized: false };
}

export function hasCompiledOwnershipEvidence(page: CompiledNoteRecognitionInput): boolean {
  if (page.source === COMPILED_NOTE_SOURCE) return true;
  return hasSystemShape(page.bodyMd).valid;
}

export function opaqueTargetHash(value: string): string {
  return createHash("sha256").update(new TextEncoder().encode(value)).digest("hex").slice(0, 16);
}
