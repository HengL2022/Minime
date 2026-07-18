// Guards the repo-root .env fallback that keeps `serve` working when launched from a cwd
// other than the repo root (Bun only auto-loads .env from cwd — see src/util/config.ts).
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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

  test("strips inline ` # comment` from unquoted values (Bun .env parity)", () => {
    const out = parseDotenv("CLOUD_MAX_TIER=1   # keep journals local\nPLAIN=abc#def\n");
    expect(out.CLOUD_MAX_TIER).toBe("1");
    expect(out.PLAIN).toBe("abc#def"); // hash without preceding whitespace is part of the value
  });

  test("quoted values keep hashes (only unquoted trailing comments are stripped)", () => {
    const out = parseDotenv(`FOO="a #b"\nBAR='c # d'\n`);
    expect(out.FOO).toBe("a #b");
    expect(out.BAR).toBe("c # d");
  });

  test("regression: the .env.example CLOUD_MAX_TIER line parses to a clean integer", () => {
    // The exact pre-2026-07-18 line. Copied via `cp .env.example .env` and read through
    // loadRepoDotenv (daemon launched from a non-repo cwd), the value parsed as
    // "2   # lower..." → Number() = NaN → `tier > NaN` is false → the egress ceiling,
    // stricter-only route check, and m0 gate all silently passed (invariant review B1).
    const line =
      "CLOUD_MAX_TIER=2                    # lower to 1 to keep journal/interactions local-only";
    expect(parseDotenv(line).CLOUD_MAX_TIER).toBe("2");
    // and the shipped .env.example itself must always yield a clean integer ceiling
    const example = readFileSync(join(import.meta.dir, "..", ".env.example"), "utf8");
    expect(Number(parseDotenv(example).CLOUD_MAX_TIER)).toBe(2);
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
