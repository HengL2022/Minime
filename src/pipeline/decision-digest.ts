// Decision digest pages are retrieval read-models for decisions. They are deliberately
// query-shaped: retrieve on the digest, then read the raw decision transcript through
// minime_get_context. Raw decision rows/transcripts remain the source of truth.

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  type DecisionDigestInput,
  decisionDigestCandidates,
  decisionDigestInput,
  decisionDigestPath,
  upsertPage,
} from "../db/repo";
import { indexParent } from "../search/index-parent";
import { config } from "../util/config";

const ACTOR = "system:dream";
const SOURCE = "dream:decision-digest";
const MAX_WORDS = 120;

export interface DecisionDigestResult {
  path: string;
  decision_id: string;
  tier: number;
  status: "updated" | "unchanged" | "skipped";
}

interface DigestParts {
  title: string;
  situation: string;
  past: string;
  takeaway: string;
}

function capWords(text: string, maxWords: number): string {
  const words = text.trim().split(/\s+/);
  if (words.length <= maxWords) return text.trim();
  return `${words.slice(0, maxWords).join(" ")} ...`;
}

function titleFor(d: DecisionDigestInput): string {
  const base = d.question.replace(/\?+$/, "").trim();
  return capWords(`When facing ${base}`, 18);
}

export function heuristicDecisionDigest(d: DecisionDigestInput): DigestParts {
  const rejected = d.branches
    .filter((b) => b.status === "rejected")
    .map((b) => b.label)
    .join(", ");
  const chosen =
    d.choice ?? d.branches.find((b) => b.status === "chosen")?.label ?? "no choice yet";
  const situation = capWords(
    [d.question, d.stakes, d.reasoning, d.falsifier ? `Falsifier: ${d.falsifier}` : ""]
      .filter(Boolean)
      .join(" "),
    MAX_WORDS,
  );
  const past = capWords(
    [
      `Past-me chose ${chosen}.`,
      rejected ? `Rejected: ${rejected}.` : "",
      d.confidence !== null && d.confidence !== undefined ? `Confidence: ${d.confidence}/100.` : "",
      d.expected_outcome ? `Expected: ${d.expected_outcome}.` : "",
    ]
      .filter(Boolean)
      .join(" "),
    MAX_WORDS,
  );
  const takeaway = capWords(
    d.actual_outcome
      ? [
          `Outcome: ${d.actual_outcome}.`,
          d.outcome_score !== null && d.outcome_score !== undefined
            ? `Outcome score: ${d.outcome_score}/100.`
            : "",
        ]
          .filter(Boolean)
          .join(" ")
      : [d.expected_outcome ? `Watch for: ${d.expected_outcome}.` : "", d.falsifier ?? ""]
          .filter(Boolean)
          .join(" "),
    MAX_WORDS,
  );
  return {
    title: titleFor(d),
    situation,
    past,
    takeaway: takeaway || "No outcome recorded yet.",
  };
}

function renderDigest(
  d: DecisionDigestInput,
  parts: DigestParts,
  compiler: "inline-draft" | "dream",
): string {
  const sources = [
    `- decision:${d.id}`,
    ...d.transcript.map((t) => `- decision_transcript:${t.id}`),
    ...d.branches.map((b) => `- decision_branch:${b.id}`),
  ].join("\n");
  return `# ${parts.title}

compiler: ${compiler}

## Situation
${parts.situation}

## Past-me decided
${parts.past}

## Takeaway
${parts.takeaway}

## Source
${sources}
`;
}

async function compileOne(
  d: DecisionDigestInput,
  compiler: "inline-draft" | "dream",
): Promise<DecisionDigestResult> {
  const path = decisionDigestPath(d.id);
  const parts = heuristicDecisionDigest(d);
  const body = renderDigest(d, parts, compiler);
  const contentHash = new Bun.CryptoHasher("sha256").update(body).digest("hex");
  const { id, changed } = await upsertPage({
    path,
    title: parts.title,
    bodyMd: body,
    contentHash,
    tier: d.tier,
    source: SOURCE,
    createdBy: ACTOR,
    derivedFrom: d.id,
  });
  if (!changed) return { path, decision_id: d.id, tier: d.tier, status: "unchanged" };
  await writeArchive(path, parts.title, d.tier, body);
  await indexParent("page", id, body, parts.title, d.tier);
  return { path, decision_id: d.id, tier: d.tier, status: "updated" };
}

async function writeArchive(
  path: string,
  title: string,
  tier: number,
  body: string,
): Promise<void> {
  const abs = join(config.dataDir, "brain", path);
  await mkdir(abs.slice(0, abs.lastIndexOf("/")), { recursive: true });
  await Bun.write(abs, `---\ntitle: "${title.replace(/"/g, '\\"')}"\ntier: ${tier}\n---\n${body}`);
}

export async function draftDecisionDigest(
  decisionId: string,
): Promise<DecisionDigestResult | null> {
  const d = await decisionDigestInput(decisionId);
  if (!d) return null;
  return compileOne(d, "inline-draft");
}

export async function compileDecisionDigests(): Promise<{
  candidates: number;
  compiled: number;
  skipped: number;
  results: DecisionDigestResult[];
}> {
  const candidates = await decisionDigestCandidates();
  const results: DecisionDigestResult[] = [];
  for (const d of candidates) {
    const r = await compileOne(d, "dream").catch(
      (): DecisionDigestResult => ({
        path: decisionDigestPath(d.id),
        decision_id: d.id,
        tier: d.tier,
        status: "skipped",
      }),
    );
    results.push(r);
  }
  const compiled = results.filter((r) => r.status === "updated").length;
  const skipped = results.length - compiled;
  return { candidates: candidates.length, compiled, skipped, results };
}
