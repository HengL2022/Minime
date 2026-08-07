// Guided setup wizard (scripts/setup-env.sh): offline, isolated in a tmp dir with a fake
// HOME so it can never touch the owner's real .env or restic password file.

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = join(import.meta.dir, "..");
const BACKUP_KEYS = [
  "RESTIC_REPOSITORY",
  "RESTIC_PASSWORD_FILE",
  "BACKUP_CRON",
  "B2_ACCOUNT_ID",
  "B2_ACCOUNT_KEY",
  "B2_APPLICATION_KEY_ID",
  "B2_APPLICATION_KEY",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_REGION",
  "AWS_DEFAULT_REGION",
] as const;

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

function envValue(env: string, key: string): string | undefined {
  const line = env.split("\n").find((candidate) => candidate.startsWith(`${key}=`));
  if (!line) return undefined;
  const raw = line.slice(key.length + 1);
  if (
    raw.length >= 2 &&
    ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'")))
  ) {
    return raw.slice(1, -1);
  }
  return raw;
}

async function setTestEnvValues(dir: string, values: Readonly<Record<string, string>>) {
  let lines = (await Bun.file(join(dir, ".env")).text()).split("\n");
  for (const [key, value] of Object.entries(values)) {
    let replaced = false;
    lines = lines.flatMap((line) => {
      if (!line.startsWith(`${key}=`) && !line.startsWith(`#${key}=`)) return [line];
      if (replaced) return [];
      replaced = true;
      return [`${key}=${value}`];
    });
    if (!replaced) lines.push(`${key}=${value}`);
  }
  await Bun.write(join(dir, ".env"), lines.join("\n"));
}

describe("setup-env wizard", () => {
  test("local defaults + local backup dir: writes private .env and password file", async () => {
    const dir = freshDir();
    // TZ default, stack=local ollama, backup=local path, dir/cadence defaults, password ack
    const { code, out } = await runWizard(dir, ["", "1", "1", "", "", ""]);
    expect(code).toBe(0);

    const env = await Bun.file(join(dir, ".env")).text();
    expect(statSync(join(dir, ".env")).mode & 0o777).toBe(0o600);
    expect(env).toContain("TZ=Asia/Singapore");
    expect(env).toContain(`RESTIC_REPOSITORY=${join(dir, "home")}/minime-restic`);
    expect(envValue(env, "BACKUP_CRON")).toBe("*/15 * * * *");

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
    expect(envValue(env, "BACKUP_CRON")).toBe(""); // backups skipped → frequent snapshots off
    expect(out).not.toContain("sk-or-fictional"); // secrets never echoed
    expect(out).toContain("--no-ollama"); // next-step hint matches the cloud choice
  });

  test("cloud + tier-2 routed local (W3): writes PROVIDER_ROUTE_TIER2 and keeps Ollama installed", async () => {
    const dir = freshDir();
    // TZ, stack=cloud, classify=openrouter(4), key, embed=keep-ollama(3),
    // CLOUD_MAX_TIER=2, "Route tier-2 to local Ollama?"=y, backup=skip(4)
    const { code, out } = await runWizard(dir, [
      "",
      "2",
      "4",
      "sk-or-fictional-route",
      "3",
      "2",
      "y",
      "4",
    ]);
    expect(code).toBe(0);
    const env = await Bun.file(join(dir, ".env")).text();
    expect(env).toContain("PROVIDER_ROUTE_TIER2=ollama");
    expect(env).toContain("CLOUD_MAX_TIER=2");
    // tier-2 still classifies locally, so Ollama must stay installed
    expect(out).not.toContain("--no-ollama");
  });

  test("B2 backup: shows the restic password but not the entered B2 key", async () => {
    const dir = freshDir();
    // TZ default, stack=local, backup=B2, bucket/id/key, cadence default, password ack
    const { code, out } = await runWizard(dir, [
      "",
      "1",
      "2",
      "minime-backup",
      "fictional-id",
      "fictional-b2-key",
      "",
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

  test("fresh skip clears every backup setting without creating a password", async () => {
    const dir = freshDir();
    const { code } = await runWizard(dir, ["", "1", "4"]);
    expect(code).toBe(0);

    const env = await Bun.file(join(dir, ".env")).text();
    for (const key of BACKUP_KEYS) expect(envValue(env, key)).toBe("");
    expect(existsSync(join(dir, "home", ".config", "minime", "restic.pass"))).toBe(false);
  });

  test("configured backup can be skipped and all destination credentials are cleared", async () => {
    const dir = freshDir();
    const configured = await runWizard(dir, [
      "",
      "1",
      "3",
      "s3:s3.amazonaws.com/fictional-minime",
      "fictional-access",
      "fictional-secret",
      "",
      "",
    ]);
    expect(configured.code).toBe(0);

    const pass = join(dir, "home", ".config", "minime", "restic.pass");
    await setTestEnvValues(dir, {
      RESTIC_REPOSITORY: "s3:s3.amazonaws.com/fictional-minime",
      RESTIC_PASSWORD_FILE: pass,
      BACKUP_CRON: "*/15 * * * *",
      B2_ACCOUNT_ID: "fictional-b2-account",
      B2_ACCOUNT_KEY: "fictional-b2-key",
      B2_APPLICATION_KEY_ID: "fictional-b2-application-id",
      B2_APPLICATION_KEY: "fictional-b2-application-key",
      AWS_ACCESS_KEY_ID: "fictional-aws-access",
      AWS_SECRET_ACCESS_KEY: "fictional-aws-secret",
      AWS_SESSION_TOKEN: "fictional-aws-session",
      AWS_REGION: "us-east-1",
      AWS_DEFAULT_REGION: "us-west-2",
    });

    const skipped = await runWizard(dir, ["", "1", "4"]);
    expect(skipped.code).toBe(0);
    const env = await Bun.file(join(dir, ".env")).text();
    for (const key of BACKUP_KEYS) expect(envValue(env, key)).toBe("");
  });

  test("skipping disconnects but does not delete an existing restic password file", async () => {
    const dir = freshDir();
    const configured = await runWizard(dir, ["", "1", "1", "", "", ""]);
    expect(configured.code).toBe(0);

    const pass = join(dir, "home", ".config", "minime", "restic.pass");
    const before = await Bun.file(pass).text();
    const skipped = await runWizard(dir, ["", "1", "4"]);
    expect(skipped.code).toBe(0);

    const env = await Bun.file(join(dir, ".env")).text();
    expect(envValue(env, "RESTIC_PASSWORD_FILE")).toBe("");
    expect(await Bun.file(pass).text()).toBe(before);
    expect(statSync(pass).mode & 0o777).toBe(0o600);
  });

  test("backup can be reconfigured after skip with a restored cadence", async () => {
    const dir = freshDir();
    const skipped = await runWizard(dir, ["", "1", "4"]);
    expect(skipped.code).toBe(0);
    // Older wizard versions represented the disabled cadence as a quoted empty value.
    await setTestEnvValues(dir, { BACKUP_CRON: '""' });

    const configured = await runWizard(dir, ["", "1", "1", "", "", ""]);
    expect(configured.code).toBe(0);

    const env = await Bun.file(join(dir, ".env")).text();
    expect(envValue(env, "RESTIC_REPOSITORY")).toBe(join(dir, "home", "minime-restic"));
    expect(envValue(env, "RESTIC_PASSWORD_FILE")).toBe(
      join(dir, "home", ".config", "minime", "restic.pass"),
    );
    expect(envValue(env, "BACKUP_CRON")).toBe("*/15 * * * *");
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
