import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");

describe("isolated demo stack contract", () => {
  test("demo.sh skips repo dotenv, provisions minime_app, and prints a serve pair", () => {
    const src = readFileSync(join(ROOT, "scripts/demo.sh"), "utf8");
    expect(src).toContain("MINIME_SKIP_REPO_DOTENV=1");
    expect(src).toContain("provision-runtime-role.ts");
    expect(src).toContain("MINIME_APP_DATABASE_URL");
    expect(src).toContain("derivePostgresCredentials");
    expect(src).toContain("minime_app");
    expect(src).toContain("MINIME_DATA_DIR");
    expect(src).not.toMatch(/^\s*(source|\.)\s+\.env/m);
    expect(src).not.toMatch(/mcp: DATABASE_URL=\$DEMO_URL bun run/);
  });
});
