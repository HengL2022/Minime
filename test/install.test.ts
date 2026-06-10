// Installer contract tests: flag handling, dry-run safety, and the machine-parsable
// summary block agents depend on. The full non-dry run is exercised manually and in CI
// (.github/workflows/install.yml) — and would recurse here via its own `bun test` step,
// so these tests skip themselves when the installer invoked us.

import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const REPO = join(import.meta.dir, "..");
const INSIDE_INSTALLER = process.env.MINIME_INSTALLER_RUNNING === "1";

function runInstaller(args: string[], env: Record<string, string> = {}) {
  const proc = Bun.spawnSync(["bash", "scripts/install.sh", ...args], {
    cwd: REPO,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: proc.exitCode,
    out: proc.stdout.toString(),
    err: proc.stderr.toString(),
  };
}

describe.skipIf(INSIDE_INSTALLER)("install.sh contract", () => {
  test("unknown flag exits 2 with usage", () => {
    const r = runInstaller(["--bogus"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("usage:");
  });

  test("dry-run: read-only, exits 0, emits the parsable summary block", () => {
    const r = runInstaller(["--dry-run", "--with-demo"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("==== MINIME INSTALL SUMMARY ====");
    const status = r.out.match(/^status: (\w+)$/m)?.[1];
    expect(["ok", "degraded"]).toContain(status!);
    // step lines follow the fixed grammar agents parse
    expect(r.out).toMatch(/^\[1\/9\] (OK|SKIP) {2,4}bun: /m);
    expect(r.out).toMatch(/^\[9\/9\] OK {2,4}mcp: /m);
  });

  test("--no-ollama yields status: degraded with recovery hint", () => {
    const r = runInstaller(["--dry-run", "--no-ollama"]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^status: degraded$/m);
    expect(r.out).toContain("review-queue");
  });

  // Full idempotent install on a provisioned box (no sudo, fast). Guarded behind an env
  // flag so plain `bun test` stays quick; CI and `make verify-install` set it.
  test.skipIf(process.env.MINIME_INSTALL_E2E !== "1")(
    "e2e: real run on a provisioned machine is idempotent and parsable",
    () => {
      const r = runInstaller(["--skip-verify"]); // verify would recurse into bun test
      expect(r.code).toBe(0);
      expect(r.out).toContain("==== MINIME INSTALL SUMMARY ====");
      const status = r.out.match(/^status: (\w+)$/m)?.[1];
      expect(["ok", "degraded"]).toContain(status!);
      expect(r.out).toMatch(/^\[3\/9\] (OK|SKIP) {2,4}postgres: /m);
    },
    120_000,
  );
});
