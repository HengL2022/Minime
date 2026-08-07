import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UNSAFE_PRIVATE_ROOT, atomicCreatePrivate } from "../src/util/atomic-file";
import { config } from "../src/util/config";

const PRIVATE_TMP = realpathSync(tmpdir());

let originalDataDir: string;
let root: string;

beforeEach(async () => {
  originalDataDir = config.dataDir;
  root = await mkdtemp(join(PRIVATE_TMP, "minime-atomic-create-"));
  await chmod(root, 0o755);
  config.dataDir = root;
});

afterEach(async () => {
  config.dataDir = originalDataDir;
  await rm(root, { recursive: true, force: true });
});

describe("atomicCreatePrivate", () => {
  test("publishes exactly one complete private file when creators race", async () => {
    const parent = join(root, "inbox");
    await mkdir(parent, { mode: 0o755 });
    const target = join(parent, "capture.md");
    const candidates = ["complete bytes from creator A", "complete bytes from creator B"];

    const results = await Promise.all(
      candidates.map((candidate) => atomicCreatePrivate(target, candidate)),
    );

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(candidates).toContain(await readFile(target, "utf8"));
    expect((await lstat(root)).mode & 0o777).toBe(0o700);
    expect((await lstat(parent)).mode & 0o777).toBe(0o700);
    expect((await lstat(target)).mode & 0o777).toBe(0o600);
    expect(await readdir(parent)).toEqual(["capture.md"]);
  });

  test("returns false and leaves an existing target unchanged", async () => {
    const target = join(root, "brain", "existing.md");
    expect(await atomicCreatePrivate(target, "original bytes")).toBe(true);

    expect(await atomicCreatePrivate(target, "replacement bytes")).toBe(false);

    expect(await readFile(target, "utf8")).toBe("original bytes");
    expect(await readdir(join(root, "brain"))).toEqual(["existing.md"]);
  });

  test("rejects a symlink target without changing its referent", async () => {
    const outside = join(root, "outside.txt");
    await writeFile(outside, "outside bytes", { mode: 0o600 });
    const parent = join(root, "inbox");
    await mkdir(parent, { mode: 0o700 });
    const target = join(parent, "capture.md");
    await symlink(outside, target);

    await expect(atomicCreatePrivate(target, "replacement bytes")).rejects.toThrow(
      UNSAFE_PRIVATE_ROOT,
    );

    expect(await readFile(outside, "utf8")).toBe("outside bytes");
    expect(await readdir(parent)).toEqual(["capture.md"]);
  });
});
