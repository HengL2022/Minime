// Installer contract tests: flag handling, dry-run safety, and the machine-parsable
// summary block agents depend on. The full non-dry run is exercised manually and in CI
// (.github/workflows/install.yml) — and would recurse here via its own `bun test` step,
// so these tests skip themselves when the installer invoked us.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
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

  test("runtime role cutover keeps credentials out of argv and repairs the endpoint atomically", () => {
    const installer = readFileSync(join(REPO, "scripts/install.sh"), "utf8");
    const makefile = readFileSync(join(REPO, "Makefile"), "utf8");
    expect(installer).toContain("chmod 600 .env");
    expect(installer).toContain('ENVIRON["MINIME_APP_DATABASE_URL"]');
    expect(installer).not.toContain("awk -v url=");
    expect(installer.indexOf("migrate --context install")).toBeLessThan(
      installer.indexOf("scripts/provision-runtime-role.ts"),
    );
    expect(installer.indexOf("scripts/provision-runtime-role.ts")).toBeLessThan(
      installer.indexOf('ENVIRON["MINIME_APP_DATABASE_URL"]'),
    );
    expect(installer).toContain("derivePostgresCredentials");
    expect(installer).not.toContain(
      'APP_DATABASE_URL="postgres://minime_app:$MINIME_APP_PASSWORD@localhost',
    );
    expect(installer).toContain('MINIME_APP_DATABASE_URL="$owner_url" bun run src/cli.ts migrate');
    expect(makefile).toContain("provision-runtime-role:");
    const provisionTarget = makefile.split("provision-runtime-role:")[1]?.split("\nseed:")[0] ?? "";
    expect(provisionTarget.indexOf("migrate --context direct")).toBeLessThan(
      provisionTarget.indexOf("scripts/provision-runtime-role.ts"),
    );
    expect(provisionTarget).toContain('"$$DATABASE_URL" != "$$owner_url"');
    expect(provisionTarget).toContain('MINIME_APP_DATABASE_URL="$$owner_url"');
    expect(provisionTarget).toContain("derivePostgresCredentials");
    expect(provisionTarget).toContain('parseLocalPostgresUrl(process.env.DATABASE_URL, "minime")');
    expect(makefile).toContain("openssl rand -hex 32");
    expect(makefile).toContain("runtime_role_configuration_invalid");
    expect(makefile).toContain('ENVIRON["MINIME_APP_DATABASE_URL"]');
    expect(makefile).not.toContain("awk -v url=");
    expect(makefile.indexOf("scripts/provision-runtime-role.ts")).toBeLessThan(
      makefile.indexOf('ENVIRON["MINIME_APP_DATABASE_URL"]'),
    );
    const provisioner = readFileSync(join(REPO, "scripts/provision-runtime-role.ts"), "utf8");
    expect(provisioner).toContain("validateMinimeDatabasePair");
    expect(provisioner).toContain('parseLocalPostgresUrl(databaseUrl, "minime")');
    expect(provisioner.indexOf("validateMinimeDatabasePair")).toBeLessThan(
      provisioner.indexOf("postgres(databaseUrl"),
    );
    expect(provisioner).toContain("runtime_role_schema_not_current");
    expect(provisioner.indexOf("021_runtime_app_role.sql")).toBeLessThan(
      provisioner.indexOf("create role minime_app"),
    );
  });

  test("demo seed stays inside the CLI owner transaction", () => {
    const seed = readFileSync(join(REPO, "fixtures/seed.ts"), "utf8");
    expect(seed).not.toContain("../src/db/client");
    expect(seed).toContain("setPersonDetails");
    expect(seed).toContain("setDecisionOutcome");
  });

  test("installer resolves and validates .env before every Postgres probe or action", () => {
    const installer = readFileSync(join(REPO, "scripts/install.sh"), "utf8");
    const lib = readFileSync(join(REPO, "scripts/lib.sh"), "utf8");
    const resolve = installer.indexOf("resolve_pg_lifecycle .env");
    expect(resolve).toBeGreaterThan(-1);
    expect(resolve).toBeLessThan(installer.indexOf("pg_bootstrap_complete; then"));
    expect(resolve).toBeLessThan(installer.indexOf("if ! pg_install_port_is_safe"));
    expect(resolve).toBeLessThan(installer.indexOf("migrate --context install"));
    expect(lib).toContain("validated_owner_port");
    expect(lib).toContain("parseLocalPostgresUrl(process.env.MINIME_LIFECYCLE_OWNER_URL");
    expect(lib).toContain('PROBE_URL="$OWNER_DATABASE_URL"');
    expect(installer).toContain('DATABASE_URL="$owner_url"');
    expect(installer).not.toContain(
      'export DATABASE_URL="postgres://minime:minime@localhost:$PG_PORT/minime"',
    );
  });

  test("Bun, backend, port, and verification contracts have one persisted source", () => {
    const installer = readFileSync(join(REPO, "scripts/install.sh"), "utf8");
    const lib = readFileSync(join(REPO, "scripts/lib.sh"), "utf8");
    const updater = readFileSync(join(REPO, "scripts/update.sh"), "utf8");
    const pin = readFileSync(join(REPO, ".bun-version"), "utf8").trim();
    expect(pin).toBe("1.3.13");
    expect(installer).toContain("pinned_bun_version");
    expect(installer).toContain("install_pinned_bun");
    expect(lib).not.toContain("MINIME_BUN_VERSION_FILE");
    expect(updater.indexOf("ensure_checked_out_bun 2")).toBeLessThan(
      updater.indexOf("backup:pre-update"),
    );
    expect(updater.indexOf("ensure_checked_out_bun 4")).toBeGreaterThan(
      updater.indexOf("git pull --ff-only"),
    );
    expect(updater.indexOf("ensure_checked_out_bun 4")).toBeLessThan(
      updater.indexOf("bun install --frozen-lockfile"),
    );
    expect(lib).toContain("persist_pg_lifecycle");
    expect(lib).toContain("MINIME_PG_INSTALL_PENDING");
    expect(lib).toContain("pg_bootstrap_complete");
    expect(lib).toContain('testUrl.pathname = "/minime_test"');
    expect(lib).toContain("rolcanlogin and rolcreatedb and rolcreaterole");
    expect(lib).toContain('r.rolname = ${"minime"}');
    expect(lib).toContain("selected_pg_backend_matches_service");
    expect(installer).toContain("bash scripts/verify-offline.sh");
    expect(installer).not.toMatch(/MINIME_INSTALLER_RUNNING=1 bun test/);
  });

  test("native Linux verification uses the installed PostgreSQL 16 client tools", () => {
    const installer = readFileSync(join(REPO, "scripts/install.sh"), "utf8");
    const clientPin = 'export PATH="/usr/lib/postgresql/16/bin:$PATH"';
    expect(installer).toContain(clientPin);
    expect(installer.indexOf(clientPin)).toBeGreaterThan(
      installer.indexOf("# =============================== 3. postgres"),
    );
    expect(installer.indexOf(clientPin)).toBeLessThan(
      installer.indexOf("# =============================== 8. verify"),
    );
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
    const hostileHost = "198.51.100.9:7777";
    const r = runInstaller(["--dry-run", "--no-ollama"], { OLLAMA_HOST: hostileHost });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^status: degraded$/m);
    expect(r.out).toContain("review-queue");
    expect(`${r.out}\n${r.err}`).not.toContain(hostileHost);
  });

  test("--no-ollama still rejects an explicitly configured remote URL", () => {
    const secret = "http://user:fictional-secret@192.168.50.4:11434";
    const r = runInstaller(["--dry-run", "--no-ollama"], {
      OLLAMA_URL: secret,
      MINIME_SKIP_REPO_DOTENV: "1",
    });
    expect(r.code).toBe(40);
    expect(r.out).toContain("[1/9] FAIL  env:");
    expect(r.out).toContain("ERROR: OLLAMA_URL rejected (credentials)");
    expect(r.out).toContain("FIX: set OLLAMA_URL=http://localhost:11434, then retry");
    expect(`${r.out}\n${r.err}`).not.toContain(secret);
    expect(`${r.out}\n${r.err}`).not.toContain("fictional-secret");
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
