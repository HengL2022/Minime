// Renders the PrecisionMemBench harness's JSON reports (retrieval + session suites) into
// a dated scorecard under docs/benchmarks/. The harness computes all numbers; this only
// formats them — the scorer stays upstream, never in our retrieval path.
//
// Usage: bun run scripts/eval-pmb-report.ts <harness-test-results-dir> [--round <label>]

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

interface Summary {
  meanLatencyMs: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  meanPrecision: number | null;
  meanRecall: number | null;
  totalPassed: number;
  totalCases: number;
  passRate: number | null;
  activeRetrievalPasses: number;
  categories: {
    category: string;
    caseCount: number;
    passed: number;
    failed: number;
    meanPrecision: number | null;
    meanRecall: number | null;
  }[];
}
interface CaseEntry {
  caseId?: string;
  category: string;
  passed: boolean;
  failures: string[];
}
interface Report {
  provider: string;
  retrieval: Summary;
  cases: CaseEntry[];
}

function flag(name: string, dflt: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? dflt) : dflt;
}

const resultsDir = process.argv[2];
if (!resultsDir) {
  console.error("usage: bun run scripts/eval-pmb-report.ts <test-results-dir> [--round <label>]");
  process.exit(2);
}
const round = flag("round", "r1");
const date = new Date().toISOString().slice(0, 10);

const pct = (x: number | null) => (x == null ? "—" : `${(100 * x).toFixed(1)}%`);

function section(title: string, r: Report): string {
  const s = r.retrieval;
  const lines = [
    `## ${title}`,
    "",
    `Pass ${s.totalPassed}/${s.totalCases} (${pct(s.passRate)}) — mean precision ${pct(s.meanPrecision)}, mean recall ${pct(s.meanRecall)}, ` +
      `latency mean ${s.meanLatencyMs}ms / p95 ${s.p95LatencyMs}ms, active-retrieval passes ${s.activeRetrievalPasses}.`,
    "",
    "| category | n | passed | precision | recall |",
    "|---|---:|---:|---:|---:|",
    ...s.categories.map(
      (c) =>
        `| ${c.category} | ${c.caseCount} | ${c.passed}/${c.caseCount} | ${pct(c.meanPrecision)} | ${pct(c.meanRecall)} |`,
    ),
  ];
  const failed = r.cases.filter((c) => !c.passed);
  if (failed.length > 0) {
    lines.push("", "### Failures (published, per harness discipline)", "");
    for (const f of failed) lines.push(`- \`${f.caseId ?? f.category}\`: ${f.failures.join("; ")}`);
  }
  return lines.join("\n");
}

const suites: [string, string][] = [
  ["Retrieval suite (77 cases)", join(resultsDir, "retrieval-report-minime.json")],
  ["Session suite (drift/noise turns)", join(resultsDir, "session-retrieval-report-minime.json")],
];

const note = flag("note", "");
const parts: string[] = [
  `# PrecisionMemBench — Minime (round ${round})`,
  "",
  "Benchmark: github.com/tenurehq/precisionmembench (judge-free retrieval-precision, 89",
  "cases / 35 beliefs). Their scoring, ported verbatim over their fixtures",
  "(scripts/eval-precisionmembench.ts); official ava-harness path for leaderboard runs:",
  "make eval-pmb-official → scripts/pmb-server.ts. Precision punishes returning extra",
  "results and letting the model sort them out.",
  ...(note ? ["", `Engine config: ${note}`] : []),
  "",
];
let found = 0;
for (const [title, path] of suites) {
  if (!existsSync(path)) {
    console.error(`WARNING: missing report ${path}`);
    continue;
  }
  parts.push(section(title, JSON.parse(readFileSync(path, "utf8")) as Report), "");
  found++;
}
if (found === 0) {
  console.error("ERROR: no harness reports found — did the ava run fail before writing?");
  process.exit(1);
}

const outDir = join(process.cwd(), "docs", "benchmarks");
mkdirSync(outDir, { recursive: true });
const out = join(outDir, `${date}-${round}-precisionmembench.md`);
writeFileSync(out, `${parts.join("\n").trimEnd()}\n`);
console.log(out);
