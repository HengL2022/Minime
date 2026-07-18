// Dream step 3c (W1, improve-w1-extract-validate.md): nightly re-validation of rule-extracted
// edges. FLAG-ONLY — disagreements go to review_queue('extract_suspect'); nothing here ever
// mutates edges/people/orgs. Verdicts land in the edge_validations ledger so idempotency,
// unsure-resampling, and per-rule miss-rates are plain SQL. Extends 3b_phantom_persons.
import {
  type EdgeToValidate,
  edgeAnchorTexts,
  edgeUnsureCount,
  edgesForValidation,
  insertEdgeValidation,
  insertReviewItem,
  reviewItemExists,
} from "../db/repo";
import { config } from "../util/config";
import { orgCue } from "./classify";

const RECENT_HOURS = 24;
const REASON_CAP = 140;
const FAMILY_CUE =
  /\b(daughter|son|wife|husband|spouse|partner|mother|father|parent|sibling|grandm\w+|grandf\w+)\b/i;
const BARE_FIRST_NAME = /^[A-Z][a-z]+$/;
// orgCue (classify.ts) is tuned for interaction-capture appositive phrasing ("a metabolomics
// company") and misses a bare vendor-style trailing noun with no such cue (e.g. "BioTree
// Supplies") — exactly the third historical archetype this heuristic must catch. A small,
// local supplement closes that gap without touching the shared classifier cue (deviation:
// see w1-task-3-report.md). Deliberately narrow: this covers the KNOWN archetype vocabulary
// seen in past incidents, not general vendor detection — the live model is the real detector.
const VENDOR_SUFFIX_CUE =
  /\b(supplies|supply|labs?|systems|solutions|holdings|logistics|pharmacy|group|enterprises|traders)\b/i;

type Verdict = {
  verdict: "confirm" | "deny" | "unsure";
  entity_type: "person" | "org" | "neither";
  reason: string;
};

/** Deterministic offline verdicts (CI): re-detects the three historical archetypes from the
 * edge shape + anchor text. The live model replaces this under real runs; the archetypes are
 * exactly what the graph-hygiene planted corpus encodes. */
export function heuristicVerdict(e: EdgeToValidate, anchor: string): Verdict {
  const dst = e.dst_name ?? "";
  if (!anchor.toLowerCase().includes(dst.toLowerCase()))
    return {
      verdict: "unsure",
      entity_type: "neither",
      reason: "evidence does not mention the target",
    };
  if (e.dst_type === "org" && BARE_FIRST_NAME.test(dst) && !orgCue(dst))
    return { verdict: "deny", entity_type: "person", reason: "bare first name, no org cue" };
  if (e.rel === "works_at" && FAMILY_CUE.test(anchor))
    return {
      verdict: "deny",
      entity_type: "person",
      reason: "family-relation context, not employment",
    };
  if (e.dst_type === "person" && (orgCue(dst) || VENDOR_SUFFIX_CUE.test(dst)))
    return { verdict: "deny", entity_type: "org", reason: "company-cue name typed as person" };
  return {
    verdict: "confirm",
    entity_type: e.dst_type === "org" ? "org" : "person",
    reason: "evidence supports the edge",
  };
}

function prompt(e: EdgeToValidate, anchor: string): string {
  const triple =
    e.rel === "works_at"
      ? `${e.src_name ?? e.src_type} -[works_at]-> ${e.dst_name}`
      : `the text mentions ${e.dst_name} (${e.dst_type})`;
  return `You are auditing one machine-extracted edge from a personal knowledge graph.
EDGE: ${triple}
EVIDENCE (all the extractor saw): "${anchor.slice(0, 600)}"
Answer ONLY {"verdict":"confirm|deny|unsure","entity_type":"person|org|neither","reason":"<=${REASON_CAP} chars"}.
confirm only if the EVIDENCE itself supports the edge; entity_type = what "${e.dst_name}" actually is per the evidence.`;
}

async function modelVerdict(
  e: EdgeToValidate,
  anchor: string,
  tier: 1 | 2,
): Promise<Verdict | null> {
  try {
    const { classifyProviderForTier } = await import("../llm");
    const raw = await classifyProviderForTier(tier).completeJson(prompt(e, anchor));
    const p = JSON.parse(raw);
    const verdict = ["confirm", "deny", "unsure"].includes(p.verdict) ? p.verdict : "unsure";
    const entity_type = ["person", "org", "neither"].includes(p.entity_type)
      ? p.entity_type
      : "neither";
    return { verdict, entity_type, reason: String(p.reason ?? "").slice(0, REASON_CAP) };
  } catch {
    return null; // provider down: leave the edge unvalidated for a future night, never guess
  }
}

export async function validateEdges(budget = 200) {
  const { classifyIsCloudForTier } = await import("../llm");
  const edges = await edgesForValidation(RECENT_HOURS, budget);
  const out = {
    checked: 0,
    confirmed: 0,
    denied: 0,
    unsure: 0,
    flagged: 0,
    byRule: {} as Record<string, { checked: number; denied: number }>,
  };
  for (const e of edges) {
    const tier = (e.tier >= 2 ? 2 : 1) as 1 | 2;
    // legacy ceiling semantics (only reachable with no route set): skip rather than send
    if (!config.mockOllama && classifyIsCloudForTier(tier) && tier > config.cloudMaxTier) continue;
    const anchors = await edgeAnchorTexts(e, e.dst_name ?? "");
    const anchor = anchors.map((a) => a.text).join(" ");
    const v = config.mockOllama ? heuristicVerdict(e, anchor) : await modelVerdict(e, anchor, tier);
    if (!v) continue;
    const ruleKey = `${e.rel}@${e.confidence}`;
    const model = config.mockOllama ? "mock" : (await import("../llm")).classifyRouteForTier(tier);
    await insertEdgeValidation({
      edgeId: e.id,
      verdict: v.verdict,
      entityType: v.entity_type,
      reason: v.reason,
      model,
      ruleKey,
    });
    out.checked++;
    out.byRule[ruleKey] ??= { checked: 0, denied: 0 };
    const rule = out.byRule[ruleKey]!;
    rule.checked++;
    const typeMismatch =
      v.verdict !== "unsure" && v.entity_type !== "neither" && v.entity_type !== e.dst_type;
    if (v.verdict === "deny" || typeMismatch) {
      out.denied++;
      rule.denied++;
      if (!(await reviewItemExists("extract_suspect", "edge_id", e.id))) {
        // IDs + names + one-line reason only — the anchor text itself never enters the payload
        await insertReviewItem("extract_suspect", {
          edge_id: e.id,
          rel: e.rel,
          rule_key: ruleKey,
          verdict: v.verdict,
          src: { type: e.src_type, id: e.src_id, name: e.src_name },
          dst: { type: e.dst_type, id: e.dst_id, name: e.dst_name },
          entity_type: v.entity_type,
          reason: v.reason,
        });
        out.flagged++;
      }
    } else if (v.verdict === "unsure") {
      out.unsure++;
      if (
        (await edgeUnsureCount(e.id)) >= 2 &&
        !(await reviewItemExists("extract_suspect", "edge_id", e.id))
      ) {
        await insertReviewItem("extract_suspect", {
          edge_id: e.id,
          rel: e.rel,
          rule_key: ruleKey,
          verdict: "unsure",
          src: { type: e.src_type, id: e.src_id, name: e.src_name },
          dst: { type: e.dst_type, id: e.dst_id, name: e.dst_name },
          entity_type: v.entity_type,
          reason: `unsure twice: ${v.reason}`.slice(0, REASON_CAP),
        });
        out.flagged++;
      }
    } else out.confirmed++;
  }
  return out;
}
