import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { repositoryInstallPendingState } from "../src/util/config";

// Hermetic shell contracts should finish well under this. The real hang-stop is
// mocking docker/native probes so CI never waits on a daemon.
const LIFECYCLE_CONTRACT_TIMEOUT_MS = 15_000;
setDefaultTimeout(LIFECYCLE_CONTRACT_TIMEOUT_MS);

const repoRoot = resolve(import.meta.dir, "..");
const lib = resolve(repoRoot, "scripts/lib.sh");
const roots: string[] = [];

function fixtureEnv(body?: string): { root: string; envFile: string; marker: string } {
  const root = mkdtempSync(join(tmpdir(), "minime-lifecycle-"));
  roots.push(root);
  const envFile = join(root, ".env");
  if (body !== undefined) writeFileSync(envFile, body, { mode: 0o600 });
  return { root, envFile, marker: join(root, "service-called") };
}

function runShell(
  script: string,
  args: string[],
  env: Record<string, string> = {},
): { code: number; out: string; err: string } {
  const result = Bun.spawnSync(["bash", "-c", script, "_", lib, ...args], {
    cwd: repoRoot,
    env: {
      ...process.env,
      MINIME_LIB_SKIP_RESOLVE: "1",
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: result.exitCode,
    out: result.stdout.toString(),
    err: result.stderr.toString(),
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("PostgreSQL lifecycle resolver", () => {
  test("Homebrew native identity reads a spaced configured port and running data directory", () => {
    const f = fixtureEnv();
    const bin = join(f.root, "bin");
    const dataDir = join(f.root, "var", "postgresql@17");
    const pgBin = join(f.root, "opt", "postgresql@17", "bin");
    mkdirSync(bin, { recursive: true });
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(pgBin, { recursive: true });
    writeFileSync(join(dataDir, "PG_VERSION"), "17\n");
    writeFileSync(join(dataDir, "postgresql.conf"), "port = 55443 # fixture\n");
    writeFileSync(
      join(bin, "brew"),
      `#!/bin/bash\nif [ "$*" = "--prefix postgresql@17" ]; then printf '%s\\n' "$FIXTURE_ROOT/opt/postgresql@17"; else printf '%s\\n' "$FIXTURE_ROOT"; fi\n`,
      { mode: 0o700 },
    );
    writeFileSync(join(pgBin, "pg_ctl"), "#!/bin/bash\nexit 0\n", { mode: 0o700 });
    chmodSync(join(bin, "brew"), 0o700);
    chmodSync(join(pgBin, "pg_ctl"), 0o700);
    const result = runShell(
      `. "$1"
printf '%s|%s\n' "$(macos_native_pg_port)" "$(macos_native_pg_running_port)"`,
      [],
      { FIXTURE_ROOT: f.root, PATH: `${bin}:${process.env.PATH ?? ""}` },
    );
    expect(result.code, result.err).toBe(0);
    expect(result.out).toBe("55443|55443\n");
  });

  test("complete persisted native state wins conflicting caller values and later Docker", () => {
    const f = fixtureEnv(
      [
        "DATABASE_URL=postgres://owner:fictional@localhost:55432/minime",
        "MINIME_PG_BACKEND=native",
        "MINIME_PG_PORT=55432",
        "",
      ].join("\n"),
    );
    const result = runShell(
      `. "$1"
docker_available(){ return 0; }
docker_backend_port(){ printf '55432\n'; }
docker_running_backend_matches_port(){ return 1; }
native_backend_port(){ printf '55432\n'; }
native_backend_matches_port(){ [ "$1" = 55432 ]; }
resolve_pg_lifecycle "$2" 0 || exit 9
printf '%s|%s|%s|%s|%s\n' "$PG_BACKEND" "$PG_PORT" "$PG_STATE_NEEDS_PERSIST" "$PG_STATE_REWRITE_OWNER" "$PG_LIFECYCLE_FRESH"`,
      [f.envFile],
      { MINIME_PG_BACKEND: "docker", MINIME_PG_PORT: "59999" },
    );
    expect(result.code, result.err).toBe(0);
    expect(result.out).toBe("native|55432|0|0|0\n");
  });

  test("persisted Docker wins --native and tolerates an inactive native config", () => {
    const f = fixtureEnv(
      [
        "DATABASE_URL=postgres://owner:fictional@localhost:55431/minime",
        "MINIME_PG_BACKEND=docker",
        "MINIME_PG_PORT=55431",
        "",
      ].join("\n"),
    );
    const result = runShell(
      `. "$1"
docker_backend_port(){ printf '55431\n'; }
docker_running_backend_matches_port(){ return 1; }
native_backend_port(){ printf '55431\n'; }
resolve_pg_lifecycle "$2" 1 || exit 9
printf '%s|%s|%s\n' "$PG_BACKEND" "$PG_PORT" "$PG_STATE_NEEDS_PERSIST"`,
      [f.envFile],
      { MINIME_PG_BACKEND: "native", MINIME_PG_PORT: "59999" },
    );
    expect(result.code, result.err).toBe(0);
    expect(result.out).toBe("docker|55431|0\n");
  });

  test("remote owner URL fails before backend/service detection and stays secret", () => {
    const secret = "postgres://owner:credential-sentinel@198.51.100.5:55432/minime";
    const f = fixtureEnv(`DATABASE_URL=${secret}\n`);
    const result = runShell(
      `. "$1"
TRACE_PATH="$3"
docker_backend_matches_port(){ printf called > "$TRACE_PATH"; return 0; }
docker_running_backend_matches_port(){ printf called > "$TRACE_PATH"; return 0; }
native_backend_matches_port(){ printf called > "$TRACE_PATH"; return 0; }
pg_provisioned(){ printf called > "$TRACE_PATH"; return 0; }
if resolve_pg_lifecycle "$2" 0; then pg_provisioned; exit 8; fi
printf '%s\n' "$PG_STATE_RULE"`,
      [f.envFile, f.marker],
    );
    expect(result.code).toBe(0);
    expect(result.out).toBe("database_url\n");
    expect(`${result.out}${result.err}`).not.toContain(secret);
    expect(`${result.out}${result.err}`).not.toContain("credential-sentinel");
    expect(existsSync(f.marker)).toBe(false);
  });

  test("legacy state adopts the actual Docker service and persists exact URL port", () => {
    const f = fixtureEnv(
      [
        "DATABASE_URL=postgres://owner:fictional@localhost:55433/minime",
        "MINIME_APP_DATABASE_URL=postgres://minime_app:fictional@localhost:55433/minime",
        "OLLAMA_URL=http://localhost:11434",
        "",
      ].join("\n"),
    );
    const result = runShell(
      `. "$1"
docker_running_backend_matches_port(){ [ "$1" = 55433 ]; }
native_running_backend_matches_port(){ [ "$1" = 55433 ]; }
resolve_pg_lifecycle "$2" 0 || exit 9
persist_pg_lifecycle "$2" 0 || exit 10
printf '%s|%s\n' "$PG_BACKEND" "$PG_PORT"`,
      [f.envFile],
    );
    expect(result.code, result.err).toBe(0);
    expect(result.out).toBe("docker|55433\n");
    const persisted = readFileSync(f.envFile, "utf8");
    expect(persisted).toContain("DATABASE_URL=postgres://owner:fictional@localhost:55433/minime");
    expect(persisted).toContain("MINIME_PG_BACKEND=docker");
    expect(persisted).toContain("MINIME_PG_PORT=55433");
    expect(persisted).toContain("MINIME_PG_INSTALL_PENDING=0");
  });

  test("persisted pending intent resumes only through the exact selected service", () => {
    const f = fixtureEnv(
      [
        "DATABASE_URL=postgres://minime:minime@localhost:55447/minime",
        "MINIME_PG_BACKEND=docker",
        "MINIME_PG_PORT=55447",
        "MINIME_PG_INSTALL_PENDING=1",
        "",
      ].join("\n"),
    );
    const exact = runShell(
      `. "$1"
docker_backend_port(){ printf '55447\\n'; }
docker_running_backend_matches_port(){ [ "$1" = 55447 ]; }
native_backend_port(){ return 1; }
port_open(){ return 0; }
resolve_pg_lifecycle "$2" 0 1 || exit 9
pg_install_port_is_safe || exit 10
printf '%s|%s|%s\\n' "$PG_INSTALL_PENDING" "$PG_LIFECYCLE_FRESH" "$PG_STATE_NEEDS_PERSIST"`,
      [f.envFile],
    );
    expect(exact.code, exact.err).toBe(0);
    expect(exact.out).toBe("1|0|0\n");

    const mismatch = runShell(
      `. "$1"
docker_backend_port(){ printf '55447\\n'; }
docker_running_backend_matches_port(){ return 1; }
native_backend_port(){ return 1; }
port_open(){ return 0; }
resolve_pg_lifecycle "$2" 0 1 || exit 9
if pg_install_port_is_safe; then exit 8; fi
printf 'refused\\n'`,
      [f.envFile],
    );
    expect(mismatch.code, mismatch.err).toBe(0);
    expect(mismatch.out).toBe("refused\n");
  });

  test("pending intent rejects any already-published runtime app endpoint", () => {
    const f = fixtureEnv(
      [
        "DATABASE_URL=postgres://minime:minime@localhost:55450/minime",
        "MINIME_APP_DATABASE_URL=postgres://minime_app:fictional@localhost:55450/minime",
        "MINIME_PG_BACKEND=docker",
        "MINIME_PG_PORT=55450",
        "MINIME_PG_INSTALL_PENDING=1",
        "",
      ].join("\n"),
    );
    const result = runShell(
      `. "$1"
if resolve_pg_lifecycle "$2" 0 1; then exit 8; fi
printf '%s\\n' "$PG_STATE_RULE"`,
      [f.envFile],
    );
    expect(result.code, result.err).toBe(0);
    expect(result.out).toBe("install_pending_app\n");
  });

  test("unpersisted fresh setup never adopts an already-open matching service", () => {
    const f = fixtureEnv("DATABASE_URL=postgres://minime:minime@localhost:55448/minime\n");
    // Fresh pg_install_port_is_safe probes running backends directly, not
    // selected_pg_backend_matches_service. Mock those so CI never talks to Docker.
    const result = runShell(
      `. "$1"
docker_available(){ return 0; }
docker_running_backend_matches_port(){ return 0; }
native_running_backend_matches_port(){ return 1; }
port_open(){ return 0; }
selected_pg_backend_matches_service(){ printf selected > "$3"; return 0; }
resolve_pg_lifecycle "$2" 0 1 || exit 9
if pg_install_port_is_safe; then exit 8; fi
printf 'refused\\n'`,
      [f.envFile, f.marker],
    );
    expect(result.code, result.err).toBe(0);
    expect(result.out).toBe("refused\n");
    expect(existsSync(f.marker)).toBe(false);
  });

  test("fresh native setup rejects an already-running cluster without an IPv4 listener", () => {
    const f = fixtureEnv("DATABASE_URL=postgres://minime:minime@localhost:55451/minime\n");
    const result = runShell(
      `. "$1"
docker_running_backend_matches_port(){ return 1; }
native_running_backend_matches_port(){ [ "$1" = 55451 ]; }
port_open(){ return 1; }
resolve_pg_lifecycle "$2" 1 1 || exit 9
if pg_install_port_is_safe; then exit 8; fi
printf 'refused\\n'`,
      [f.envFile],
    );
    expect(result.code, result.err).toBe(0);
    expect(result.out).toBe("refused\n");
  });

  test("fresh explicit native and custom port precede Docker/defaults", () => {
    const f = fixtureEnv();
    const result = runShell(
      `. "$1"
docker_available(){ return 0; }
resolve_pg_lifecycle "$2" 1 1 || exit 9
printf '%s|%s|%s|%s\n' "$PG_BACKEND" "$PG_PORT" "$PG_STATE_NEEDS_PERSIST" "$PG_STATE_REWRITE_OWNER"`,
      [f.envFile],
      { MINIME_PG_BACKEND: "docker", MINIME_PG_PORT: "55434" },
    );
    expect(result.code, result.err).toBe(0);
    expect(result.out).toBe("native|55434|1|1\n");
  });

  test("setup-created env accepts an explicit first-install port without changing bootstrap credentials", () => {
    const f = fixtureEnv("DATABASE_URL=postgres://minime:minime@localhost:5432/minime\n");
    const result = runShell(
      `. "$1"
docker_running_backend_matches_port(){ return 1; }
native_running_backend_matches_port(){ return 1; }
resolve_pg_lifecycle "$2" 0 1 || exit 9
persist_pg_lifecycle "$2" "$PG_STATE_REWRITE_OWNER" || exit 10
printf '%s|%s|%s|%s|%s\n' "$PG_BACKEND" "$PG_PORT" "$PG_STATE_NEEDS_PERSIST" "$PG_STATE_REWRITE_OWNER" "$PG_LIFECYCLE_FRESH"`,
      [f.envFile],
      { MINIME_PG_BACKEND: "docker", MINIME_PG_PORT: "55433" },
    );
    expect(result.code, result.err).toBe(0);
    expect(result.out).toBe("docker|55433|0|1|1\n");
    const persisted = readFileSync(f.envFile, "utf8");
    expect(persisted).toContain("DATABASE_URL=postgres://minime:minime@localhost:55433/minime");
    expect(persisted).toContain("MINIME_PG_BACKEND=docker");
    expect(persisted).toContain("MINIME_PG_PORT=55433");
    expect(persisted).toContain("MINIME_PG_INSTALL_PENDING=1");
  });

  test("setup-only custom owner credentials fail before fresh backend detection", () => {
    const f = fixtureEnv(
      "DATABASE_URL=postgres://setup_owner:setup-fictional-secret@localhost:5432/minime\n",
    );
    const result = runShell(
      `. "$1"
docker_available(){ printf detected > "$3"; return 0; }
if resolve_pg_lifecycle "$2" 0 1; then exit 8; fi
printf '%s' "$PG_STATE_RULE"`,
      [f.envFile, f.marker],
      { MINIME_PG_PORT: "55433" },
    );
    expect(result.code, result.err).toBe(0);
    expect(result.out).toBe("fresh_owner_credentials");
    expect(existsSync(f.marker)).toBe(false);
  });

  test("setup-only env is not treated as an installed backend by lifecycle commands", () => {
    const f = fixtureEnv("DATABASE_URL=postgres://setup_owner:fictional@localhost:5432/minime\n");
    const result = runShell(
      `. "$1"
docker_running_backend_matches_port(){ return 1; }
native_running_backend_matches_port(){ [ "$1" = 5432 ]; }
if resolve_pg_lifecycle "$2" 0; then exit 8; fi
printf '%s\n' "$PG_STATE_RULE"`,
      [f.envFile],
    );
    expect(result.code).toBe(0);
    expect(result.out).toBe("install_required\n");
  });

  test("a mismatched runtime URL fails before legacy service adoption", () => {
    const secret = "runtime-pair-fictional-secret";
    const f = fixtureEnv(
      [
        "DATABASE_URL=postgres://owner:fictional@localhost:55444/minime",
        `MINIME_APP_DATABASE_URL=postgres://minime_app:${secret}@localhost:55445/minime`,
        "",
      ].join("\n"),
    );
    const result = runShell(
      `. "$1"
TRACE_PATH="$3"
docker_running_backend_matches_port(){ printf called > "$TRACE_PATH"; return 0; }
native_running_backend_matches_port(){ printf called > "$TRACE_PATH"; return 0; }
if resolve_pg_lifecycle "$2" 0; then exit 8; fi
printf '%s\n' "$PG_STATE_RULE"`,
      [f.envFile, f.marker],
    );
    expect(result.code).toBe(0);
    expect(result.out).toBe("app_database_url\n");
    expect(`${result.out}${result.err}`).not.toContain(secret);
    expect(existsSync(f.marker)).toBe(false);
  });

  test("persisted port must exactly match the validated owner URL", () => {
    const f = fixtureEnv(
      [
        "DATABASE_URL=postgres://owner:fictional@localhost:55435/minime",
        "MINIME_PG_BACKEND=docker",
        "MINIME_PG_PORT=55436",
        "",
      ].join("\n"),
    );
    const result = runShell(
      `. "$1"
TRACE_PATH="$3"
pg_provisioned(){ printf called > "$TRACE_PATH"; return 0; }
if resolve_pg_lifecycle "$2" 0; then pg_provisioned; exit 8; fi
printf '%s\n' "$PG_STATE_RULE"`,
      [f.envFile, f.marker],
    );
    expect(result.code).toBe(0);
    expect(result.out).toBe("port_url_mismatch\n");
    expect(existsSync(f.marker)).toBe(false);
  });

  test("malformed owner URL fails before the credential probe", () => {
    const f = fixtureEnv("DATABASE_URL=not-a-postgres-url\n");
    const result = runShell(
      `. "$1"
TRACE_PATH="$3"
pg_provisioned(){ printf called > "$TRACE_PATH"; return 0; }
if resolve_pg_lifecycle "$2" 0; then pg_provisioned; exit 8; fi
printf '%s\n' "$PG_STATE_RULE"`,
      [f.envFile, f.marker],
    );
    expect(result.code).toBe(0);
    expect(result.out).toBe("database_url\n");
    expect(existsSync(f.marker)).toBe(false);
  });

  test("the exact validated credential URL reaches the owner probe", () => {
    const ownerUrl = "postgres://owner:exact-fictional-secret@localhost:55437/minime";
    const f = fixtureEnv(
      [`DATABASE_URL=${ownerUrl}`, "MINIME_PG_BACKEND=docker", "MINIME_PG_PORT=55437", ""].join(
        "\n",
      ),
    );
    const result = runShell(
      `. "$1"
docker_backend_port(){ printf '55437\\n'; }
docker_running_backend_matches_port(){ [ "$1" = 55437 ]; }
resolve_pg_lifecycle "$2" 0 || exit 9
TRACE_PATH="$3"
bun(){ printf '%s' "$PROBE_URL" > "$TRACE_PATH"; return 0; }
pg_owner_reachable || exit 10`,
      [f.envFile, f.marker],
    );
    expect(result.code, result.err).toBe(0);
    expect(readFileSync(f.marker, "utf8")).toBe(ownerUrl);
    expect(`${result.out}${result.err}`).not.toContain("exact-fictional-secret");
  });

  test("persisted native state rejects a running Docker service on the same port", () => {
    const f = fixtureEnv(
      [
        "DATABASE_URL=postgres://owner:fictional@localhost:55438/minime",
        "MINIME_PG_BACKEND=native",
        "MINIME_PG_PORT=55438",
        "",
      ].join("\n"),
    );
    const result = runShell(
      `. "$1"
native_backend_port(){ printf '55438\n'; }
docker_running_backend_matches_port(){ [ "$1" = 55438 ]; }
if resolve_pg_lifecycle "$2" 0; then exit 8; fi
printf '%s\n' "$PG_STATE_RULE"`,
      [f.envFile],
    );
    expect(result.code).toBe(0);
    expect(result.out).toBe("backend_service_mismatch\n");
  });

  test("legacy state does not adopt a configured but stopped native cluster", () => {
    const f = fixtureEnv(
      [
        "DATABASE_URL=postgres://owner:fictional@localhost:55438/minime",
        "MINIME_APP_DATABASE_URL=postgres://minime_app:fictional@localhost:55438/minime",
        "",
      ].join("\n"),
    );
    const result = runShell(
      `. "$1"
docker_running_backend_matches_port(){ return 1; }
native_backend_matches_port(){ [ "$1" = 55438 ]; }
native_running_backend_matches_port(){ return 1; }
if resolve_pg_lifecycle "$2" 0; then exit 8; fi
printf '%s\n' "$PG_STATE_RULE"`,
      [f.envFile],
    );
    expect(result.code).toBe(0);
    expect(result.out).toBe("legacy_backend_unknown\n");
  });

  test("the exact reachable owner URL cannot certify a different selected backend", () => {
    const ownerUrl = "postgres://owner:probe-fictional-secret@localhost:55439/minime";
    const f = fixtureEnv(
      [`DATABASE_URL=${ownerUrl}`, "MINIME_PG_BACKEND=docker", "MINIME_PG_PORT=55439", ""].join(
        "\n",
      ),
    );
    const result = runShell(
      `. "$1"
docker_backend_port(){ printf '55439\\n'; }
docker_running_backend_matches_port(){ return 1; }
resolve_pg_lifecycle "$2" 0 || exit 9
TRACE_PATH="$3"
bun(){ printf '%s' "$PROBE_URL" > "$TRACE_PATH"; return 0; }
docker_running_backend_matches_port(){ return 1; }
native_backend_matches_port(){ return 0; }
if pg_provisioned && selected_pg_backend_matches_service; then printf 'wrong\n'; exit 8; fi
printf 'refused\n'`,
      [f.envFile, f.marker],
    );
    expect(result.code, result.err).toBe(0);
    expect(result.out).toBe("refused\n");
    expect(readFileSync(f.marker, "utf8")).toBe(ownerUrl);
    expect(`${result.out}${result.err}`).not.toContain("probe-fictional-secret");
  });

  test("stop identity refuses mismatched native and configured Docker ports", () => {
    const result = runShell(
      `. "$1"
PG_BACKEND=native
PG_PORT=55440
native_backend_matches_port(){ return 1; }
selected_pg_backend_safe_to_stop && exit 8
PG_BACKEND=docker
docker_backend_port(){ printf '55441\n'; }
selected_pg_backend_safe_to_stop && exit 9
printf 'refused\n'`,
      [],
    );
    expect(result.code, result.err).toBe(0);
    expect(result.out).toBe("refused\n");
  });

  test("a configured but stopped native cluster cannot certify a reachable database", () => {
    const result = runShell(
      `. "$1"
PG_BACKEND=native
PG_PORT=55442
native_backend_matches_port(){ return 0; }
native_running_backend_matches_port(){ return 1; }
docker_running_backend_matches_port(){ return 1; }
selected_pg_backend_matches_service && exit 8
printf 'refused\n'`,
      [],
    );
    expect(result.code, result.err).toBe(0);
    expect(result.out).toBe("refused\n");
  });
});

describe("lifecycle entrypoint contract", () => {
  test("install resolves before probes and up/down select only the persisted backend", () => {
    const installer = readFileSync(resolve(repoRoot, "scripts/install.sh"), "utf8");
    const up = readFileSync(resolve(repoRoot, "scripts/up.sh"), "utf8");
    const down = readFileSync(resolve(repoRoot, "scripts/down.sh"), "utf8");
    expect(installer.indexOf("resolve_pg_lifecycle .env")).toBeLessThan(
      installer.indexOf("pg_bootstrap_complete; then"),
    );
    expect(installer).toContain("pg_conftool 16 main set port");
    for (const source of [up, down]) {
      expect(source).toContain("resolve_pg_lifecycle .env");
      expect(source).toContain('if [ "$PG_BACKEND" = docker ]');
    }
    expect(up).not.toContain("if docker_available; then");
    expect(down).not.toContain("command -v docker");
    expect(up).not.toContain("systemctl start postgresql ");
    const safePort = installer.indexOf("if ! pg_install_port_is_safe");
    const persistIntent = installer.indexOf(
      'persist_pg_lifecycle .env "$PG_STATE_REWRITE_OWNER"',
      safePort,
    );
    const provision = installer.indexOf("provision_docker ||", persistIntent);
    expect(safePort).toBeGreaterThan(-1);
    expect(persistIntent).toBeGreaterThan(safePort);
    expect(provision).toBeGreaterThan(persistIntent);
    expect(installer).toContain("trap release_install_lock EXIT");
    expect(installer).toContain('PG_INSTALL_PENDING" = 0 ] && pg_bootstrap_complete');
    const fullPostcondition = installer.indexOf(
      'pg_bootstrap_complete || die 20 postgres "Postgres bootstrap invariant failed',
    );
    const clearPending = installer.indexOf("PG_INSTALL_PENDING=0", fullPostcondition);
    expect(fullPostcondition).toBeGreaterThan(provision);
    expect(clearPending).toBeGreaterThan(fullPostcondition);
    for (const source of [installer, up]) {
      const bootstrapSites = source.split("ensure_pg_objects");
      expect(bootstrapSites).toHaveLength(4);
      for (const beforeBootstrap of bootstrapSites.slice(0, -1)) {
        expect(beforeBootstrap.lastIndexOf("pg_owner_reachable")).toBeGreaterThan(-1);
      }
    }
  });

  test("CI reruns omit backend and port inputs after custom-port installs", () => {
    const workflow = readFileSync(resolve(repoRoot, ".github/workflows/install.yml"), "utf8");
    const rerunBlocks =
      workflow.match(/- name: re-run is idempotent[\s\S]*?(?=\n\s{2}\S|$)/g) ?? [];
    expect(rerunBlocks).toHaveLength(1);
    expect(rerunBlocks[0]).toContain("bash scripts/install.sh --no-ollama");
    expect(rerunBlocks[0]).not.toContain("--native");
    expect(rerunBlocks[0]).not.toContain("MINIME_PG_PORT=");
    expect(workflow).toContain("bash scripts/install.sh --no-ollama | tee rerun.log");
  });

  test("up and down fail closed without installed lifecycle state", () => {
    const f = fixtureEnv();
    const scripts = join(f.root, "scripts");
    const bin = join(f.root, "bin");
    mkdirSync(scripts, { recursive: true });
    mkdirSync(bin, { recursive: true });
    for (const name of ["lib.sh", "up.sh", "down.sh"]) {
      const target = join(scripts, name);
      writeFileSync(target, readFileSync(resolve(repoRoot, "scripts", name)), { mode: 0o700 });
      chmodSync(target, 0o700);
    }
    for (const name of ["docker", "brew", "systemctl", "pg_ctlcluster"]) {
      const target = join(bin, name);
      writeFileSync(target, `#!/bin/bash\nprintf called > ${JSON.stringify(f.marker)}\n`, {
        mode: 0o700,
      });
      chmodSync(target, 0o700);
    }
    for (const name of ["up.sh", "down.sh"]) {
      const result = Bun.spawnSync(["bash", join(scripts, name)], {
        cwd: f.root,
        env: { ...process.env, PATH: `${bin}:/usr/bin:/bin` },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(result.exitCode).toBe(40);
      expect(result.stderr.toString()).toContain(".env is required");
      expect(existsSync(f.marker)).toBe(false);
    }
  });

  test("migrate and both serve entrypoints reject persisted pending install state", () => {
    for (const command of ["migrate", "serve", "serve:runtime"]) {
      const result = Bun.spawnSync([process.execPath, "run", "src/cli.ts", command], {
        cwd: repoRoot,
        env: {
          ...process.env,
          NODE_ENV: "test",
          MINIME_SKIP_REPO_DOTENV: "1",
          MINIME_PG_INSTALL_PENDING: "1",
          DATABASE_URL: "postgres://minime:minime@localhost:5432/minime",
          MINIME_APP_DATABASE_URL: "postgres://minime_app:fictional@localhost:5432/minime",
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(result.exitCode).toBe(40);
      expect(result.stderr.toString()).toContain("PostgreSQL installation");
    }
  });

  test("public CLI lifecycle state rejects ambient override and malformed persisted markers", () => {
    const f = fixtureEnv("MINIME_PG_INSTALL_PENDING=1\n");
    expect(repositoryInstallPendingState({ MINIME_PG_INSTALL_PENDING: "1" }, f.envFile)).toBe(
      "pending",
    );
    expect(repositoryInstallPendingState({ MINIME_PG_INSTALL_PENDING: "0" }, f.envFile)).toBe(
      "invalid",
    );
    writeFileSync(f.envFile, "MINIME_PG_INSTALL_PENDING=yes\n", { mode: 0o600 });
    expect(repositoryInstallPendingState({ MINIME_PG_INSTALL_PENDING: "yes" }, f.envFile)).toBe(
      "invalid",
    );
  });

  test("down is an idempotent no-op for an identified native cluster that is already stopped", () => {
    const f = fixtureEnv(
      [
        "DATABASE_URL=postgres://owner:fictional@localhost:55446/minime",
        "MINIME_PG_BACKEND=native",
        "MINIME_PG_PORT=55446",
        "",
      ].join("\n"),
    );
    const scripts = join(f.root, "scripts");
    const bin = join(f.root, "bin");
    mkdirSync(scripts, { recursive: true });
    mkdirSync(bin, { recursive: true });
    writeFileSync(
      join(scripts, "lib.sh"),
      `${readFileSync(resolve(repoRoot, "scripts/lib.sh"), "utf8")}
validated_owner_port(){ printf '55446\\n'; }
native_backend_port(){ printf '55446\\n'; }
native_running_backend_matches_port(){ return 1; }
docker_running_backend_matches_port(){ return 1; }
`,
      { mode: 0o700 },
    );
    writeFileSync(
      join(scripts, "down.sh"),
      readFileSync(resolve(repoRoot, "scripts/down.sh"), "utf8"),
      { mode: 0o700 },
    );
    for (const name of ["docker", "brew", "systemctl", "pg_ctlcluster"]) {
      writeFileSync(
        join(bin, name),
        `#!/bin/bash\nprintf called > ${JSON.stringify(f.marker)}\nexit 91\n`,
        { mode: 0o700 },
      );
      chmodSync(join(bin, name), 0o700);
    }
    const result = Bun.spawnSync(["bash", join(scripts, "down.sh")], {
      cwd: f.root,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}` },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(existsSync(f.marker)).toBe(false);
  });
});
