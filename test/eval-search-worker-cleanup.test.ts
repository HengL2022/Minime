import { describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "..");
const WORKER_ARGS = [
  "bun",
  "run",
  "scripts/eval-search-worker.ts",
  "--mode",
  "mock",
  "--round",
  "cleanup-test",
  "--repeat",
  "0",
  "--seed",
  "1",
  "--corpus",
  "decisions-en",
  "--qrels",
  "decision-digest.json",
] as const;
const INTEGRATION_TIMEOUT_MS = 30_000;

function controlledTmp(): { root: string; fixtureFile: string; nestedFixture: string } {
  const root = realpathSync(
    mkdtempSync(join(realpathSync(tmpdir()), "minime-eval-worker-cleanup-")),
  );
  const fixtureFile = join(root, "fixture.keep");
  const fixtureDir = join(root, "fixture-dir");
  const nestedFixture = join(fixtureDir, "nested.keep");
  mkdirSync(fixtureDir);
  writeFileSync(fixtureFile, "fixture-file\n");
  writeFileSync(nestedFixture, "nested-fixture\n");
  return { root, fixtureFile, nestedFixture };
}

function expectOnlyFixturesRemain(fixture: ReturnType<typeof controlledTmp>): void {
  expect(readdirSync(fixture.root).sort()).toEqual(["fixture-dir", "fixture.keep"]);
  expect(readFileSync(fixture.fixtureFile, "utf8")).toBe("fixture-file\n");
  expect(readFileSync(fixture.nestedFixture, "utf8")).toBe("nested-fixture\n");
}

function runOwnedWorker(tmpRoot: string) {
  return Bun.spawnSync(
    [
      "bun",
      "run",
      "scripts/with-test-database.ts",
      "--label",
      "eval_search",
      "--database-env",
      "EVAL_DATABASE_URL",
      "--",
      ...WORKER_ARGS,
    ],
    {
      cwd: repoRoot,
      env: { ...process.env, TMPDIR: tmpRoot, MINIME_MOCK_OLLAMA: "1" },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
}

function runFailingWorker(tmpRoot: string) {
  const unavailableDsn =
    "postgres://minime_test_app_cleanup:cleanup_password@127.0.0.1:1/minime_test_cleanup";
  return Bun.spawnSync([...WORKER_ARGS], {
    cwd: repoRoot,
    env: {
      ...process.env,
      TMPDIR: tmpRoot,
      MINIME_MOCK_OLLAMA: "1",
      MINIME_SKIP_REPO_DOTENV: "1",
      DATABASE_URL: unavailableDsn,
      MINIME_APP_DATABASE_URL: unavailableDsn,
      EVAL_DATABASE_URL: unavailableDsn,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
}

describe("decisions evaluator scratch cleanup", () => {
  test(
    "removes only its owned decisions temp directory after success",
    () => {
      const fixture = controlledTmp();
      try {
        const result = runOwnedWorker(fixture.root);
        expect(result.exitCode).toBe(0);
        const report = JSON.parse(result.stdout.toString().trim().split("\n").at(-1) ?? "{}");
        expect(report).toMatchObject({
          protocol: 1,
          kind: "minime-eval-result",
          corpus: "decisions-en",
        });
        expectOnlyFixturesRemain(fixture);
      } finally {
        rmSync(fixture.root, { recursive: true, force: true });
      }
    },
    { timeout: INTEGRATION_TIMEOUT_MS },
  );

  test(
    "removes only its owned decisions temp directory after a post-allocation failure",
    () => {
      const fixture = controlledTmp();
      try {
        const result = runFailingWorker(fixture.root);
        expect(result.exitCode).toBe(1);
        expect(result.stderr.toString().trim().length).toBeGreaterThan(0);
        expectOnlyFixturesRemain(fixture);
      } finally {
        rmSync(fixture.root, { recursive: true, force: true });
      }
    },
    { timeout: INTEGRATION_TIMEOUT_MS },
  );
});
