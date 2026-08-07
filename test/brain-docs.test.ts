import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");

describe("brain archive documentation", () => {
  test("describes explicit sync and does not promise a nested repo or resident watcher", async () => {
    const [readme, guide] = await Promise.all([
      Bun.file(join(ROOT, "README.md")).text(),
      Bun.file(join(ROOT, "docs", "GUIDE.md")).text(),
    ]);
    const activeDocs = `${readme}\n${guide}`;
    expect(activeDocs).toContain("bun run src/cli.ts sync");
    expect(activeDocs).toContain("The resident watcher monitors `data/inbox/`");
    expect(activeDocs).not.toContain("its own git repo");
    expect(activeDocs).not.toContain("let the resident server pick it up");
  });
});
