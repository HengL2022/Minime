import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "..");
const packageJson = JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf8")) as {
  scripts?: Record<string, string>;
  devDependencies?: Record<string, string>;
};
const makefile = readFileSync(resolve(repoRoot, "Makefile"), "utf8");
const tsconfig = JSON.parse(readFileSync(resolve(repoRoot, "tsconfig.json"), "utf8")) as {
  compilerOptions?: Record<string, unknown>;
  include?: string[];
};
const workflow = readFileSync(resolve(repoRoot, ".github/workflows/eval.yml"), "utf8");
const claude = readFileSync(resolve(repoRoot, "CLAUDE.md"), "utf8");
const agents = readFileSync(resolve(repoRoot, "AGENTS.md"), "utf8");
const readme = readFileSync(resolve(repoRoot, "README.md"), "utf8");

function makeDryRun(target: string): string {
  const result = Bun.spawnSync(["make", "-n", target], {
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = new TextDecoder().decode(result.stdout);
  const stderr = new TextDecoder().decode(result.stderr);
  expect(result.exitCode).toBe(0);
  return `${stdout}\n${stderr}`;
}

describe("authoritative verification contract", () => {
  test("package scripts and exact TypeScript pin are authoritative", () => {
    expect(packageJson.scripts).toMatchObject({
      test: "bun test",
      lint: "biome check .",
      format: "biome check --write .",
      typecheck: "tsc --noEmit",
    });
    expect(packageJson.devDependencies?.typescript).toBe("5.9.3");
  });

  test("strict compiler scope remains limited to source, tests, and fixtures", () => {
    expect(tsconfig.compilerOptions?.strict).toBe(true);
    expect(tsconfig.compilerOptions?.noUncheckedIndexedAccess).toBe(true);
    expect(tsconfig.include).toEqual(["src", "test", "fixtures"]);
  });

  test("Make exposes offline and release gates", () => {
    expect(makefile).toMatch(/^lint:\n\t@\$\(BUN\) run lint$/m);
    expect(makefile).toMatch(/^format:\n\t@\$\(BUN\) run format$/m);
    expect(makefile).toMatch(/^typecheck:\n\t@\$\(BUN\) run typecheck$/m);
    expect(makefile).toMatch(
      /^verify-offline: verify-m0-offline test lint typecheck typecheck-ops check-subsystems$/m,
    );
    expect(makefile).toMatch(/^verify: verify-offline eval-search$/m);
    expect(makefile).toMatch(/^verify-m0:\n\t@\$\(BUN\) run src\/verify\/m0\.ts$/m);
  });

  test("offline dry-run has one unscoped test and no milestone prerequisites", () => {
    const dryRun = makeDryRun("verify-offline");
    expect((dryRun.match(/\bbun test\b/g) ?? []).length).toBe(1);
    expect(dryRun).not.toMatch(/verify-m[1-9][0-5]?\b/);
    expect(dryRun).toContain("verify_m0");
    expect(dryRun).toContain("MINIME_MOCK_OLLAMA=1");
    expect(dryRun).toMatch(
      /scripts\/with-test-database\.ts --label verify_m0 -- \\\n\t+bun run src\/verify\/m0\.ts/,
    );
    expect(dryRun).toContain("scripts/check-subsystems.ts");
    expect(dryRun).not.toMatch(/\bcreatedb\b|minime_test\b|minime_eval\b/);
  });

  test("final dry-run is the offline gate plus coordinator-owned retrieval evaluation", () => {
    const dryRun = makeDryRun("verify");
    expect(dryRun).toContain("bun test");
    expect(dryRun).toContain("scripts/eval-search.ts --mode mock --round mock");
    expect(dryRun).not.toMatch(/verify-m[1-9][0-5]?\b/);
    expect(dryRun).not.toMatch(/\bcreatedb\b|minime_test\b|minime_eval\b/);
  });

  test("CI has one authoritative make verify gate and preserves service bootstrap posture", () => {
    expect((workflow.match(/run:\s*make verify\s*$/gm) ?? []).length).toBe(1);
    expect(workflow).toContain("bootstrap Minime databases as service administrator");
    expect(workflow).toContain(
      "create role minime login password 'minime' nosuperuser createdb createrole",
    );
    expect(workflow).toContain('= "f|t|t"');
    expect(workflow).not.toMatch(/run:\s*make verify-m\d/);
  });

  test("docs identify verify-offline as fast development gate and verify as release gate", () => {
    for (const document of [claude, agents, readme]) {
      expect(document).toMatch(/verify-offline/);
      expect(document).toMatch(/verify/);
    }
    expect(claude).toMatch(/verify-offline[^\n]*(fast|merge)/i);
    expect(agents).toMatch(/verify-offline[^\n]*(fast|merge)/i);
    expect(readme).toMatch(/verify-offline[^\n]*(fast|merge)/i);
    expect(claude).toMatch(/verify[^\n]*(final|retrieval)/i);
    expect(agents).toMatch(/verify[^\n]*(final|retrieval)/i);
    expect(readme).toMatch(/verify[^\n]*(final|retrieval)/i);
  });
});
