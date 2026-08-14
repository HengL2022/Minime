import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { ALL_TOOLS } from "../src/mcp/tools";

const repoRoot = resolve(import.meta.dir, "..");
const packageJson = JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf8")) as {
  packageManager?: string;
  scripts?: Record<string, string>;
  devDependencies?: Record<string, string>;
};
const makefile = readFileSync(resolve(repoRoot, "Makefile"), "utf8");
const tsconfig = JSON.parse(readFileSync(resolve(repoRoot, "tsconfig.json"), "utf8")) as {
  compilerOptions?: Record<string, unknown>;
  include?: string[];
};
const workflow = readFileSync(resolve(repoRoot, ".github/workflows/eval.yml"), "utf8");
const installWorkflow = readFileSync(resolve(repoRoot, ".github/workflows/install.yml"), "utf8");
const offlineCoordinator = readFileSync(resolve(repoRoot, "scripts/verify-offline.sh"), "utf8");
const claude = readFileSync(resolve(repoRoot, "CLAUDE.md"), "utf8");
const agents = readFileSync(resolve(repoRoot, "AGENTS.md"), "utf8");
const readme = readFileSync(resolve(repoRoot, "README.md"), "utf8");

function makeDryRun(target: string, variables: string[] = []): string {
  const result = Bun.spawnSync(["make", "-n", "--no-print-directory", target, ...variables], {
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = new TextDecoder().decode(result.stdout);
  const stderr = new TextDecoder().decode(result.stderr);
  expect(result.exitCode).toBe(0);
  // Nested `make verify-offline` sets MAKEFLAGS=--print-directory. The explicit
  // `--no-print-directory` usually wins, but still strip Entering/Leaving
  // banners so the assertion is the recipe text, not the invoker's chatter.
  return `${stdout}\n${stderr}`
    .split("\n")
    .filter((line) => !/^make(\[\d+\])?: (Entering|Leaving) directory/.test(line))
    .join("\n");
}

describe("authoritative verification contract", () => {
  test("package scripts and exact runtime/type pins are authoritative", () => {
    expect(packageJson.scripts).toMatchObject({
      test: "bun test",
      lint: "biome check .",
      format: "biome check --write .",
      typecheck: "tsc --noEmit",
    });
    expect(readFileSync(resolve(repoRoot, ".bun-version"), "utf8").trim()).toBe("1.3.13");
    expect(packageJson.packageManager).toBe("bun@1.3.13");
    expect(packageJson.devDependencies?.["@types/bun"]).toBe("1.3.13");
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
    expect(makefile).toMatch(/^verify-offline:\n\t@bash scripts\/verify-offline\.sh$/m);
    expect(makefile).toMatch(/^verify: verify-offline eval-search$/m);
    expect(makefile).toMatch(/^verify-m0:\n\t@\$\(BUN\) run src\/verify\/m0\.ts$/m);
  });

  test("recovery targets route through the no-dotenv argv wrapper", () => {
    expect(makeDryRun("restore-drill").trim()).toBe(
      "bun --no-env-file run scripts/recovery-ops.ts drill",
    );
    expect(makeDryRun("promote-restore").trim()).toBe(
      "bun --no-env-file run scripts/recovery-ops.ts promote",
    );
    const pitr = makeDryRun("restore-pitr", ["TIME=opaque restore time"]);
    expect(pitr.trim()).toBe('bun --no-env-file run scripts/recovery-ops.ts pitr "${TIME}"');
    expect(pitr).not.toContain("opaque restore time");
  });

  test("Make keeps a hostile restore TIME value opaque", () => {
    const root = mkdtempSync(resolve(tmpdir(), "minime-make-time-"));
    const sentinel = resolve(root, "make-expanded-time");
    try {
      const dryRun = makeDryRun("restore-pitr", [`TIME=$(shell touch ${sentinel})`]);
      expect(dryRun.trim()).toBe('bun --no-env-file run scripts/recovery-ops.ts pitr "${TIME}"');
      expect(existsSync(sentinel)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("dry-run recipe text ignores nested make directory banners", () => {
    const previous = process.env.MAKEFLAGS;
    process.env.MAKEFLAGS = "--print-directory";
    try {
      expect(makeDryRun("verify-offline").trim()).toBe("bash scripts/verify-offline.sh");
      expect(makeDryRun("restore-drill").trim()).toBe(
        "bun --no-env-file run scripts/recovery-ops.ts drill",
      );
    } finally {
      if (previous === undefined) delete process.env.MAKEFLAGS;
      else process.env.MAKEFLAGS = previous;
    }
  });

  test("offline target delegates to one complete canonical coordinator", () => {
    const dryRun = makeDryRun("verify-offline");
    expect(dryRun.trim()).toBe("bash scripts/verify-offline.sh");
    expect((offlineCoordinator.match(/\bbun test\b/g) ?? []).length).toBe(1);
    expect(offlineCoordinator).toContain("MINIME_MOCK_OLLAMA=1");
    expect(offlineCoordinator).toContain("scripts/with-test-database.ts --label verify_m0");
    expect(offlineCoordinator).toContain("bun run lint");
    expect(offlineCoordinator).toContain("bun run typecheck");
    expect(offlineCoordinator).toContain("bun run typecheck:ops");
    expect(offlineCoordinator).toContain("scripts/check-subsystems.ts");
  });

  test("final dry-run is the offline gate plus coordinator-owned retrieval evaluation", () => {
    const dryRun = makeDryRun("verify");
    expect(dryRun).toContain("bash scripts/verify-offline.sh");
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
    expect(workflow).toContain("bun-version-file: .bun-version");
    expect((installWorkflow.match(/bun-version-file: \.bun-version/g) ?? []).length).toBe(3);
    expect(installWorkflow).toContain("MINIME_PG_PORT=55432");
    expect(installWorkflow).toContain("MINIME_PG_PORT=55433");
  });

  test("owner and agent docs list every registered MCP tool", () => {
    const resolver = readFileSync(resolve(repoRoot, "agents/skills/RESOLVER.md"), "utf8");
    const names = ALL_TOOLS.map((t) => t.name);
    expect(names).toHaveLength(22);
    for (const document of [readme, agents, resolver]) {
      expect(document).not.toMatch(/\b14 (tools|functions)\b/);
      for (const name of names) {
        expect(document).toContain(name);
      }
    }
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
