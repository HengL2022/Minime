// Compiled-notes dream step (search-uplift Phase 2; spec §15 "consolidated entity pages",
// owner-approved 2026-06-12). For each person/org with ≥3 mentioning chunks, distill a
// ≤300-word factual note page at derived/notes/<kind>/<slug>.md with strict provenance:
// source='dream:notes', created_by='system:dream', derived_from = a representative source row,
// tier = max(tier of the source chunks). The note cites its source chunk IDs in a markdown
// list at the bottom so agents can verify every claim (I5/I7). The distillation prompt forbids
// invention. Notes are content like any other page — indexParent chunks + embeds them.
//
// Staleness: a note is recompiled only when the entity gained a new mention since the last
// compile (the note page's updated_at vs. the latest mention-edge time). Unchanged entities
// cost no model call. Mock mode (MINIME_MOCK_OLLAMA=1) uses a deterministic heuristic so the
// suite runs offline.

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  type NoteCandidate,
  noteCandidates,
  notePageFreshness,
  noteSourceChunks,
  upsertPage,
} from "../db/repo";
import { indexParent } from "../search/index-parent";
import { config } from "../util/config";

const ACTOR = "system:dream";
const SOURCE = "dream:notes";
const MIN_CHUNKS = 3;
const MAX_WORDS = 300;

interface SourceChunk {
  id: string;
  parent_type: string;
  parent_id: string;
  text: string;
  tier: number;
}

// derived/notes/<kind>/<slug>.md — ASCII-sluggable names get a readable path; non-ASCII /
// symbol-only names fall back to the entity id so the path stays a valid, stable, unique key.
function notePath(c: NoteCandidate): string {
  const slug = c.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
  const safe = slug || c.id;
  return `derived/notes/${c.kind}/${safe}.md`;
}

// Trim to ~maxWords on a word boundary without splitting mid-word; never adds content.
function capWords(text: string, maxWords: number): string {
  const words = text.trim().split(/\s+/);
  if (words.length <= maxWords) return text.trim();
  return `${words.slice(0, maxWords).join(" ")} …`;
}

// Deterministic offline distillation: the leading factual sentence(s) of each source chunk,
// de-duplicated, capped at MAX_WORDS. No new claims — every sentence is verbatim from a source.
export function heuristicDistill(name: string, chunks: SourceChunk[]): string {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const c of chunks) {
    const plain = c.text
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/[*_`#>]+/g, "")
      .replace(/\s+/g, " ")
      .trim();
    const sentence = (plain.split(/(?<=[.!?])\s+/)[0] ?? plain).trim();
    const key = sentence.toLowerCase();
    if (sentence.length < 8 || seen.has(key)) continue;
    seen.add(key);
    lines.push(sentence);
  }
  return capWords(`${name}: ${lines.join(" ")}`, MAX_WORDS);
}

// Classify provider (local Ollama by default). CLOUD_MAX_TIER gate (§12, same pattern as
// the contradiction scan): when the provider is cloud, chunks above the ceiling are dropped
// BEFORE the prompt is built — tier-2 text never leaves the box uninvited. If the gate
// empties the source list, the caller falls back to the local heuristic distillation.
async function modelDistill(name: string, allChunks: SourceChunk[]): Promise<string> {
  const { classifyProvider, classifyIsCloud } = await import("../llm");
  const chunks = classifyIsCloud()
    ? allChunks.filter((c) => c.tier <= config.cloudMaxTier)
    : allChunks;
  if (chunks.length === 0) throw new Error("all source chunks above CLOUD_MAX_TIER");
  const sources = chunks.map((c, i) => `[S${i + 1}] ${c.text.slice(0, 1200)}`).join("\n\n");
  // The prompt forbids invention: facts must come verbatim from the sources (I5/I7 spirit).
  const prompt = `You are compiling a factual reference note about "${name}" from the source excerpts below. Write a neutral, ${MAX_WORDS}-word-or-fewer distillation.

STRICT RULES:
- Use ONLY facts stated in the sources. Invent NOTHING — no dates, numbers, relationships, or details that are not present verbatim.
- If the sources conflict, state both rather than choosing.
- No speculation, no opinions, no filler.

SOURCES:
${sources}

Reply with ONLY {"note": "<the distillation>"}.`;
  const raw = await classifyProvider().completeJson(prompt);
  const note = (JSON.parse(raw).note ?? "").toString().trim();
  if (!note) throw new Error("empty distillation");
  return capWords(note, MAX_WORDS);
}

function renderNote(name: string, distillation: string, chunks: SourceChunk[]): string {
  const sources = chunks.map((c) => `- ${c.id}`).join("\n");
  return `# ${name}

*Compiled note — distilled by the dream job from the sources below. No new claims; verify against the cited source rows.*

${distillation}

## Sources
${sources}
`;
}

export interface NoteResult {
  path: string;
  kind: string;
  tier: number;
  status: "created" | "updated" | "unchanged" | "skipped";
}

// Compile (or refresh) the note for one entity. Returns "skipped" with no model call when the
// note is already fresh (no mention newer than the note's last compile).
async function compileOne(c: NoteCandidate): Promise<NoteResult> {
  const path = notePath(c);
  const existing = await notePageFreshness(path);
  if (existing && new Date(existing.updated_at) >= new Date(c.latest_mention_at)) {
    return { path, kind: c.kind, tier: c.max_tier, status: "skipped" };
  }

  const chunks = await noteSourceChunks(c.kind, c.id);
  if (chunks.length < MIN_CHUNKS) {
    return { path, kind: c.kind, tier: c.max_tier, status: "skipped" };
  }
  const tier = chunks.reduce((max, ch) => Math.max(max, ch.tier), 0);
  const representative = chunks[0]!.parent_id; // earliest mentioning row (derived_from)

  // cloud-gate fallback: if every source chunk sits above CLOUD_MAX_TIER (or the provider
  // fails), distill locally rather than sending tier-locked text off-box or dropping the
  // note. Log the reason (entity name only, never chunk text) so degradation is visible.
  const distillation = config.mockOllama
    ? heuristicDistill(c.name, chunks)
    : await modelDistill(c.name, chunks).catch((e) => {
        console.error(
          `[dream:notes] model distill failed for "${c.name}" (${e instanceof Error ? e.message : e}); using heuristic`,
        );
        return heuristicDistill(c.name, chunks);
      });
  const body = renderNote(c.name, distillation, chunks);
  const contentHash = new Bun.CryptoHasher("sha256").update(body).digest("hex");

  const { id, changed } = await upsertPage({
    path,
    title: c.name,
    bodyMd: body,
    contentHash,
    tier,
    source: SOURCE,
    createdBy: ACTOR,
    derivedFrom: representative,
  });
  if (!changed) return { path, kind: c.kind, tier, status: "unchanged" };

  // mirror the markdown into the brain archive (I4) and index like any other page
  await writeArchive(path, body);
  await indexParent("page", id, body, c.name, tier);
  return { path, kind: c.kind, tier, status: existing ? "updated" : "created" };
}

async function writeArchive(path: string, body: string): Promise<void> {
  const abs = join(config.dataDir, "brain", path);
  await mkdir(abs.slice(0, abs.lastIndexOf("/")), { recursive: true });
  await Bun.write(abs, body);
}

// Dream step (runs after entity linking, before the contradiction scan). Compiles a note for
// every entity with ≥MIN_CHUNKS mentioning chunks; skips fresh ones with no model call.
export async function compileNotes(): Promise<{
  candidates: number;
  compiled: number;
  skipped: number;
  results: NoteResult[];
}> {
  const candidates = await noteCandidates(MIN_CHUNKS);
  const results: NoteResult[] = [];
  for (const c of candidates) {
    const r = await compileOne(c).catch(
      (): NoteResult => ({
        path: notePath(c),
        kind: c.kind,
        tier: c.max_tier,
        status: "skipped",
      }),
    );
    results.push(r);
  }
  const compiled = results.filter((r) => r.status === "created" || r.status === "updated").length;
  const skipped = results.length - compiled;
  return { candidates: candidates.length, compiled, skipped, results };
}
