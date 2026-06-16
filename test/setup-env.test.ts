// Guided setup wizard (scripts/setup-env.sh): offline, isolated in a tmp dir with a fake
// HOME so it can never touch the owner's real .env or restic password file.

import { describe, expect, test } from "bun:test";
import { mkdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = join(import.meta.dir, "..");

function freshDir(): string {
  const d = join(tmpdir(), `minime-setup-${Math.random().toString(36).slice(2, 10)}`);
  mkdirSync(join(d, "scripts"), { recursive: true });
  mkdirSync(join(d, "home"), { recursive: true });
  return d;
}

async function runWizard(dir: string, answers: string[]) {
  await Bun.write(
    join(dir, "scripts", "setup-env.sh"),
    await Bun.file(join(REPO, "scripts", "setup-env.sh")).text(),
  );
  await Bun.write(join(dir, ".env.example"), await Bun.file(join(REPO, ".env.example")).text());
  const proc = Bun.spawnSync(["bash", "scripts/setup-env.sh"], {
    cwd: dir,
    stdin: Buffer.from(`${answers.join("\n")}\n`),
    env: { ...process.env, HOME: join(dir, "home"), PATH: "/usr/bin:/bin" }, // no restic on PATH
  });
  return { code: proc.exitCode, out: proc.stdout.toString() };
}

describe("setup-env wizard", () => {
  test("local defaults + local backup dir: writes private .env and password file", async () => {
    const dir = freshDir();
    // TZ default, stack=local ollama, backup=local path, dir default, ack the password prompt
    const { code, out } = await runWizard(dir, ["", "1", "1", "", ""]);
    expect(code).toBe(0);

    const env = await Bun.file(join(dir, ".env")).text();
    expect(statSync(join(dir, ".env")).mode & 0o777).toBe(0o600);
    expect(env).toContain("TZ=Asia/Singapore");
    expect(env).toContain(`RESTIC_REPOSITORY=${join(dir, "home")}/minime-restic`);

    const pass = join(dir, "home", ".config", "minime", "restic.pass");
    expect(statSync(pass).mode & 0o777).toBe(0o600);
    const passVal = (await Bun.file(pass).text()).trim();
    expect(passVal.length).toBeGreaterThanOrEqual(40);
    expect(out).toContain("BACK THIS FILE UP");
    // the generated password is surfaced once so the owner can record it (write-it-down banner)
    expect(out).toContain("shown ONCE");
    expect(out).toContain(passVal);
  });

  test("cloud providers: sets routing keys without echoing secrets", async () => {
    const dir = freshDir();
    // TZ, stack=cloud, classify=openrouter(4), key, embed=openrouter(1), key,
    // CLOUD_MAX_TIER=1, backup=skip(4)
    const { code, out } = await runWizard(dir, [
      "UTC",
      "2",
      "4",
      "sk-or-fictional",
      "1",
      "sk-or-fictional",
      "1",
      "4",
    ]);
    expect(code).toBe(0);
    const env = await Bun.file(join(dir, ".env")).text();
    expect(env).toContain("CLASSIFY_PROVIDER=openrouter");
    expect(env).toContain("EMBED_PROVIDER=openrouter");
    expect(env).toContain("OPENROUTER_API_KEY=sk-or-fictional");
    expect(env).toContain("CLOUD_MAX_TIER=1");
    expect(env).toContain('BACKUP_CRON=""'); // backups skipped → frequent snapshots off
    expect(out).not.toContain("sk-or-fictional"); // secrets never echoed
    expect(out).toContain("--no-ollama"); // next-step hint matches the cloud choice
  });

  test("B2 backup: shows the restic password but not the entered B2 key", async () => {
    const dir = freshDir();
    // TZ default, stack=local ollama, backup=B2(2), bucket, B2_ACCOUNT_ID, B2_ACCOUNT_KEY, ack
    const { code, out } = await runWizard(dir, [
      "",
      "1",
      "2",
      "minime-backup",
      "fictional-id",
      "fictional-b2-key",
      "",
    ]);
    expect(code).toBe(0);

    const env = await Bun.file(join(dir, ".env")).text();
    expect(env).toContain("RESTIC_REPOSITORY=b2:minime-backup:restic");
    expect(env).toContain("B2_ACCOUNT_KEY=fictional-b2-key"); // stored in .env...
    expect(out).not.toContain("fictional-b2-key"); // ...but never echoed to the terminal

    // the generated restic password IS surfaced once, for any configured destination
    const pass = join(dir, "home", ".config", "minime", "restic.pass");
    const passVal = (await Bun.file(pass).text()).trim();
    expect(out).toContain("shown ONCE");
    expect(out).toContain(passVal);
  });

  test("re-run backs up the previous .env and keeps values as defaults", async () => {
    const dir = freshDir();
    await runWizard(dir, ["Europe/Berlin", "1", "4"]);
    const { code } = await runWizard(dir, ["", "1", "4"]); // accept current TZ as default
    expect(code).toBe(0);
    const env = await Bun.file(join(dir, ".env")).text();
    expect(env).toContain("TZ=Europe/Berlin");
    const { readdirSync } = await import("node:fs");
    expect(readdirSync(dir).some((f) => f.startsWith(".env.bak-"))).toBe(true);
  });
});
