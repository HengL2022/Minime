// W3-6 contract: install-service renders the launchd/systemd templates with no placeholder
// tokens left over, and never touches the filesystem under DRY_RUN=1. The real (non-dry-run)
// install/uninstall path calls launchctl/systemctl, which this suite never exercises -- see
// docs/GUIDE.md "Keeping Minime running" for the owner-run command.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const REPO = join(import.meta.dir, "..");
const PLACEHOLDER = /@[A-Za-z0-9_]+@/g;

function runInstallService(action: "install" | "uninstall", env: Record<string, string> = {}) {
  const proc = Bun.spawnSync(["bash", "scripts/install-service.sh", action], {
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

describe("install-service.sh contract", () => {
  test("unknown action exits 2 with usage", () => {
    const r = runInstallService("bogus" as "install", {});
    expect(r.code).toBe(2);
    expect(r.err).toContain("usage:");
  });

  test("unknown FORCE_OS exits 2", () => {
    const r = runInstallService("install", { DRY_RUN: "1", FORCE_OS: "windows" });
    expect(r.code).toBe(2);
    expect(r.err).toContain("FORCE_OS must be macos or debian");
  });

  test("DRY_RUN install renders the macOS launchd plist with no placeholder tokens", () => {
    const before = existsSync(join(homedir(), "Library/LaunchAgents/com.minime.serve.plist"));
    const r = runInstallService("install", { DRY_RUN: "1", FORCE_OS: "macos" });
    expect(r.code).toBe(0);
    expect(r.out).toContain("DRY_RUN: would write");
    expect(r.out).toContain(`${homedir()}/Library/LaunchAgents/com.minime.serve.plist`);
    expect(r.out).toContain("<key>Label</key>");
    expect(r.out).toContain("<string>com.minime.serve</string>");
    expect(r.out).toContain(`<string>${REPO}</string>`); // WorkingDirectory
    expect(r.out).toContain("<string>run</string>");
    expect(r.out).toContain("<string>src/cli.ts</string>");
    expect(r.out).toContain("<string>serve</string>");
    expect(r.out).toContain(`${REPO}/data/logs/serve.log`);
    expect(r.out).toContain("<key>RunAtLoad</key>");
    expect(r.out).toContain("<key>KeepAlive</key>");
    expect(r.out.match(PLACEHOLDER)).toBeNull();
    // dry-run never touches the real LaunchAgents directory
    expect(existsSync(join(homedir(), "Library/LaunchAgents/com.minime.serve.plist"))).toBe(before);
    expect(existsSync(join(REPO, "data/logs"))).toBe(false);
  });

  test("FORCE_OS=debian previews the systemd --user unit with no placeholder tokens", () => {
    const before = existsSync(join(homedir(), ".config/systemd/user/minime.service"));
    const r = runInstallService("install", { DRY_RUN: "1", FORCE_OS: "debian" });
    expect(r.code).toBe(0);
    expect(r.out).toContain("DRY_RUN: would write");
    expect(r.out).toContain(`${homedir()}/.config/systemd/user/minime.service`);
    expect(r.out).toContain("[Unit]");
    expect(r.out).toContain(`WorkingDirectory=${REPO}`);
    expect(r.out).toMatch(/ExecStart=.*\/bun run src\/cli\.ts serve/);
    expect(r.out).toContain("Restart=on-failure");
    expect(r.out).toContain("WantedBy=default.target");
    expect(r.out.match(PLACEHOLDER)).toBeNull();
    expect(existsSync(join(homedir(), ".config/systemd/user/minime.service"))).toBe(before);
  });

  test("DRY_RUN uninstall reports the target and touches nothing", () => {
    const r = runInstallService("uninstall", { DRY_RUN: "1", FORCE_OS: "macos" });
    expect(r.code).toBe(0);
    expect(r.out).toContain("DRY_RUN: would stop and remove");
    expect(r.out).toContain("com.minime.serve.plist");
  });

  test("templates only use the three documented placeholders", () => {
    const plist = readFileSync(join(REPO, "ops/service/com.minime.serve.plist.tmpl"), "utf8");
    const unit = readFileSync(join(REPO, "ops/service/minime.service.tmpl"), "utf8");
    const allowed = new Set(["@REPO_ROOT@", "@BUN_PATH@", "@HOME@"]);
    for (const tmpl of [plist, unit]) {
      for (const token of tmpl.match(PLACEHOLDER) ?? []) {
        expect(allowed.has(token)).toBe(true);
      }
    }
    // and the render script substitutes exactly those three
    const script = readFileSync(join(REPO, "scripts/install-service.sh"), "utf8");
    expect(script).toContain("@REPO_ROOT@");
    expect(script).toContain("@BUN_PATH@");
    expect(script).toContain("@HOME@");
  });

  test("Makefile wires install-service/uninstall-service to the script", () => {
    const makefile = readFileSync(join(REPO, "Makefile"), "utf8");
    expect(makefile).toContain("install-service:\n\t@bash scripts/install-service.sh install");
    expect(makefile).toContain("uninstall-service:\n\t@bash scripts/install-service.sh uninstall");
    expect(makefile).toContain(" install-service ");
    expect(makefile).toContain(" uninstall-service ");
  });

  test("docs point at make install-service instead of the raw launchd/systemd clause", () => {
    const readme = readFileSync(join(REPO, "README.md"), "utf8");
    const guide = readFileSync(join(REPO, "docs/GUIDE.md"), "utf8");
    expect(readme).toContain("make install-service");
    expect(readme).not.toContain("run `bun run src/cli.ts serve` under launchd/systemd");
    expect(guide).toContain("### Keeping Minime running");
    expect(guide).toContain("make install-service");
    expect(guide).toContain("make uninstall-service");
    expect(guide).toContain("launchctl list | grep minime");
    expect(guide).toContain("systemctl --user status minime");
  });
});
