// W2 complexity-budget gate: docs/SUBSYSTEMS.md ↔ src/ structural coverage, both directions.
// Rule v1 (deliberately simple + deterministic): every top-level entry under src/ must be
// mentioned in some row's "What / where" cell, and every `src/...` path cited anywhere in the
// doc must exist. No git, no network — identical result locally and in CI.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export function checkSubsystems(repoRoot: string): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  const docPath = join(repoRoot, "docs/SUBSYSTEMS.md");
  if (!existsSync(docPath)) return { ok: false, problems: ["docs/SUBSYSTEMS.md is missing"] };
  const doc = readFileSync(docPath, "utf-8");

  // direction 1: every cited src/ path exists (rows cannot rot)
  const cited = [...doc.matchAll(/`(src\/[^`]+?)`/g)].map((m) => m[1]!);
  for (const p of new Set(cited)) {
    if (!existsSync(join(repoRoot, p))) problems.push(`cited path does not exist: ${p}`);
  }

  // direction 2: every top-level src/ entry is covered by some row
  for (const entry of readdirSync(join(repoRoot, "src"))) {
    const rel = `src/${entry}`;
    const isDir = statSync(join(repoRoot, rel)).isDirectory();
    const needle = isDir ? `src/${entry}/` : rel;
    if (!doc.includes(needle) && !doc.includes(rel))
      problems.push(
        `no SUBSYSTEMS.md row mentions ${rel} — add a row (complexity budget) or fold it into an existing one`,
      );
    void isDir;
  }
  return { ok: problems.length === 0, problems };
}

if (import.meta.main) {
  const res = checkSubsystems(process.cwd());
  for (const p of res.problems) console.error(`SUBSYSTEMS: ${p}`);
  console.log(res.ok ? "SUBSYSTEMS: ok" : `SUBSYSTEMS: ${res.problems.length} problem(s)`);
  process.exit(res.ok ? 0 : 1);
}
