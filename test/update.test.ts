// Update script guard rails (scripts/update.sh) — offline pieces only: flag validation
// and the dirty-working-tree refusal. The happy path (fetch + ff-pull + migrate) needs a
// network remote and is exercised by owner runs of `make update`.

import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = join(import.meta.dir, "..");

describe("update script", () => {
  test("unknown flag exits 2 without doing anything", () => {
    const proc = Bun.spawnSync(["bash", "scripts/update.sh", "--bogus"], { cwd: REPO });
    expect(proc.exitCode).toBe(2);
  });

  test("refuses to run over local modifications to tracked files", async () => {
    // a scratch git repo with the script in place and one dirty tracked file
    const dir = join(tmpdir(), `minime-update-${Math.random().toString(36).slice(2, 10)}`);
    mkdirSync(join(dir, "scripts"), { recursive: true });
    await Bun.write(
      join(dir, "scripts", "update.sh"),
      await Bun.file(join(REPO, "scripts", "update.sh")).text(),
    );
    writeFileSync(join(dir, "tracked.txt"), "v1\n");
    const git = (...args: string[]) => Bun.spawnSync(["git", "-C", dir, ...args]);
    git("init", "-q");
    git("-c", "user.email=t@t", "-c", "user.name=t", "add", ".");
    git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");
    writeFileSync(join(dir, "tracked.txt"), "v2 dirty\n");

    const proc = Bun.spawnSync(["bash", "scripts/update.sh"], { cwd: dir });
    expect(proc.exitCode).toBe(30);
    const out = proc.stdout.toString();
    expect(out).toContain("local modifications");
    expect(out).toContain("FIX: git stash");
  });
});
