// Guards the repo-root .env fallback that keeps `serve` working when launched from a cwd
// other than the repo root (Bun only auto-loads .env from cwd — see src/util/config.ts).
import { describe, expect, test } from "bun:test";
import { fillMissingEnv, parseDotenv } from "../src/util/config";

describe("parseDotenv", () => {
  test("parses KEY=VALUE, ignoring blanks and comments", () => {
    const out = parseDotenv(
      "# comment\n\nRESTIC_REPOSITORY=b2:bucket:restic\nBACKUP_CRON=*/15 * * * *\n",
    );
    expect(out.RESTIC_REPOSITORY).toBe("b2:bucket:restic");
    expect(out.BACKUP_CRON).toBe("*/15 * * * *");
  });

  test("strips surrounding quotes and the `export ` prefix", () => {
    const out = parseDotenv(`export FOO="a b"\nBAR='c'\n`);
    expect(out.FOO).toBe("a b");
    expect(out.BAR).toBe("c");
  });

  test("keeps `=` inside values (splits on first `=` only)", () => {
    const out = parseDotenv("DATABASE_URL=postgres://u:p@h:5432/db?x=1\n");
    expect(out.DATABASE_URL).toBe("postgres://u:p@h:5432/db?x=1");
  });
});

describe("fillMissingEnv", () => {
  test("never overrides a key the caller already set", () => {
    const target: NodeJS.ProcessEnv = { RESTIC_REPOSITORY: "caller-wins" };
    fillMissingEnv({ RESTIC_REPOSITORY: "from-file", BACKUP_CRON: "*/15 * * * *" }, target);
    expect(target.RESTIC_REPOSITORY).toBe("caller-wins");
    expect(target.BACKUP_CRON).toBe("*/15 * * * *");
  });
});
