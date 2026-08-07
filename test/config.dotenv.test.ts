// Guards the repo-root .env fallback that keeps `serve` working when launched from a cwd
// other than the repo root (Bun only auto-loads .env from cwd — see src/util/config.ts).
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  EMBED_PROVIDER_NAMES,
  PROVIDER_NAMES,
  assertTier2UnlockApprovalWindowMinutes,
  assertTier2UnlockMaxMinutes,
  fillMissingEnv,
  parseDotenv,
  parseEmbedProviderName,
  parseProviderEnvironment,
  parseProviderName,
  parseTier2UnlockApprovalWindowMinutes,
  parseTier2UnlockMaxMinutes,
} from "../src/util/config";
import {
  derivePostgresCredentials,
  parseLocalPostgresUrl,
  validateMinimeDatabasePair,
} from "../src/util/postgres-url";

function loadConfigWith(owner: string, app: string, extraEnv: Record<string, string> = {}) {
  const proc = Bun.spawnSync(
    [process.execPath, "--no-env-file", "-e", 'await import("./src/util/config")'],
    {
      cwd: join(import.meta.dir, ".."),
      env: {
        NODE_ENV: "test",
        MINIME_SKIP_REPO_DOTENV: "1",
        ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
        DATABASE_URL: owner,
        MINIME_APP_DATABASE_URL: app,
        ...extraEnv,
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  return { code: proc.exitCode, output: proc.stdout.toString() + proc.stderr.toString() };
}

describe("provider configuration", () => {
  test("accepts only exact canonical provider names", () => {
    for (const provider of PROVIDER_NAMES) expect(parseProviderName(provider)).toBe(provider);
    for (const malformed of ["", "none", "OpenAI", "OPENAI", " openai", "openai ", "gpt5"]) {
      expect(() => parseProviderName(malformed)).toThrow("provider_invalid");
    }
  });

  test("embedding providers are the exact supported subset", () => {
    for (const provider of EMBED_PROVIDER_NAMES) {
      expect(parseEmbedProviderName(provider)).toBe(provider);
    }
    for (const unsupported of ["anthropic", "bedrock", "OpenAI", " openai", "openai "]) {
      expect(() => parseEmbedProviderName(unsupported)).toThrow("EMBED_PROVIDER_invalid");
    }
  });

  test("uses the same exact parser for base providers and optional tier routes", () => {
    expect(
      parseProviderEnvironment({
        EMBED_PROVIDER: "openrouter",
        CLASSIFY_PROVIDER: "anthropic",
        PROVIDER_ROUTE_TIER1: "bedrock",
        PROVIDER_ROUTE_TIER2: "ollama",
      }),
    ).toEqual({
      embedProvider: "openrouter",
      classifyProvider: "anthropic",
      providerRouteTier1: "bedrock",
      providerRouteTier2: "ollama",
    });
    expect(parseProviderEnvironment({})).toEqual({
      embedProvider: "ollama",
      classifyProvider: "ollama",
      providerRouteTier1: undefined,
      providerRouteTier2: undefined,
    });
  });

  test("config load rejects malformed base and route values without exposing credentials", () => {
    const database = "postgres://owner:secret@localhost:5432/minime";
    for (const [setting, value] of [
      ["EMBED_PROVIDER", "OpenAI"],
      ["EMBED_PROVIDER", "anthropic"],
      ["EMBED_PROVIDER", "bedrock"],
      ["CLASSIFY_PROVIDER", "openai "],
      ["PROVIDER_ROUTE_TIER1", " openrouter"],
      ["PROVIDER_ROUTE_TIER2", ""],
    ] as const) {
      const result = loadConfigWith(database, database, {
        [setting]: value,
        OPENAI_API_KEY: "credential-that-must-not-appear",
      });
      expect(result.code).not.toBe(0);
      expect(result.output).toContain(`${setting}_invalid`);
      expect(result.output).not.toContain("credential-that-must-not-appear");
    }
  });
});

describe("data-root configuration boundary", () => {
  test("rejects broad backup/mutation roots at config load without changing their modes", () => {
    const database = "postgres://owner:secret@localhost:5432/minime";
    const repo = join(import.meta.dir, "..");
    const broadSpellings = [
      "/",
      "/tmp",
      "/var",
      "/private/tmp",
      "/private/var",
      tmpdir(),
      homedir(),
      homedir().toUpperCase(),
      `/System/Volumes/Data${homedir()}`,
      repo,
    ].filter(existsSync);
    const broadRoots = new Set([
      ...broadSpellings,
      ...broadSpellings.map((path) => realpathSync(path)),
    ]);
    for (const root of broadRoots) {
      const before = statSync(root).mode & 0o777;
      const result = loadConfigWith(database, database, { MINIME_DATA_DIR: root });
      expect(result.code).not.toBe(0);
      expect(result.output).toContain("UNSAFE_PRIVATE_ROOT");
      expect(statSync(root).mode & 0o777).toBe(before);
    }
  });
});

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

describe("tier-2 unlock limit", () => {
  test("accepts only bounded positive decimal integers", () => {
    expect(parseTier2UnlockMaxMinutes("1")).toBe(1);
    expect(parseTier2UnlockMaxMinutes("60")).toBe(60);
    expect(parseTier2UnlockMaxMinutes("1440")).toBe(1440);
    for (const raw of ["", "0", "-1", "1.5", "1e2", "NaN", "Infinity", "1441"]) {
      expect(() => parseTier2UnlockMaxMinutes(raw)).toThrow(/TIER2_UNLOCK_MAX_MINUTES/);
    }
  });

  test("runtime guard fails closed if a test or caller mutates parsed config", () => {
    for (const value of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 1441]) {
      expect(() => assertTier2UnlockMaxMinutes(value)).toThrow(/TIER2_UNLOCK_MAX_MINUTES/);
    }
  });
});

describe("tier-2 unlock approval window", () => {
  test("accepts only bounded positive decimal integers", () => {
    expect(parseTier2UnlockApprovalWindowMinutes("1")).toBe(1);
    expect(parseTier2UnlockApprovalWindowMinutes("10")).toBe(10);
    expect(parseTier2UnlockApprovalWindowMinutes("60")).toBe(60);
    for (const raw of ["", "0", "-1", "1.5", "1e2", "NaN", "Infinity", "61"]) {
      expect(() => parseTier2UnlockApprovalWindowMinutes(raw)).toThrow(
        /TIER2_UNLOCK_APPROVAL_WINDOW_MINUTES/,
      );
    }
  });

  test("runtime guard fails closed if a test or caller mutates parsed config", () => {
    for (const value of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 61]) {
      expect(() => assertTier2UnlockApprovalWindowMinutes(value)).toThrow(
        /TIER2_UNLOCK_APPROVAL_WINDOW_MINUTES/,
      );
    }
  });

  test("config load rejects an out-of-range or malformed env override", () => {
    const database = "postgres://owner:secret@localhost:5432/minime";
    for (const value of ["0", "61", "abc", "-1", "1.5"]) {
      const result = loadConfigWith(database, database, {
        TIER2_UNLOCK_APPROVAL_WINDOW_MINUTES: value,
      });
      expect(result.code).not.toBe(0);
      expect(result.output).toContain("TIER2_UNLOCK_APPROVAL_WINDOW_MINUTES");
    }
  });

  test("config load defaults to 10 and accepts an explicit in-range override", () => {
    const database = "postgres://owner:secret@localhost:5432/minime";
    expect(loadConfigWith(database, database).code).toBe(0);
    expect(
      loadConfigWith(database, database, { TIER2_UNLOCK_APPROVAL_WINDOW_MINUTES: "30" }).code,
    ).toBe(0);
  });
});

describe("Postgres configuration boundary", () => {
  test("accepts exact loopback pairs for live and guarded scratch databases", () => {
    for (const url of [
      "postgres://owner:secret@LOCALHOST/minime",
      "postgres://owner:secret@127.0.0.1:6543/minime_test_runtime_123",
      "postgres://owner:secret@[::1]:5432/minime_eval_lme1",
    ]) {
      expect(() => validateMinimeDatabasePair(url, url)).not.toThrow();
      expect(loadConfigWith(url, url).code).toBe(0);
    }
  });

  test("keeps localhost, IPv4, and IPv6 as distinct server identities", () => {
    const owner = "postgres://owner:secret@localhost:5432/minime";
    for (const app of [
      "postgres://minime_app:secret@127.0.0.1:5432/minime",
      "postgres://minime_app:secret@[::1]:5432/minime",
      "postgres://minime_app:secret@localhost:5433/minime",
    ]) {
      expect(() => validateMinimeDatabasePair(owner, app)).toThrow("database_endpoint_invalid");
    }
  });

  test("config load rejects malformed, remote, and split endpoints with a fixed secret-free error", () => {
    const secret = "database-boundary-secret";
    const owner = `postgres://owner:${secret}@localhost:5432/minime`;
    for (const app of [
      `postgres://minime_app:${secret}@database.example.test:5432/minime`,
      `mysql://minime_app:${secret}@localhost:5432/minime`,
      `postgres://minime_app:${secret}@localhost:5432/postgres`,
      `postgres://minime_app:${secret}@localhost:5432/minime?host=database.example.test`,
      `postgres://minime_app:${secret}@127.0.0.1:5432/minime`,
    ]) {
      const result = loadConfigWith(owner, app);
      expect(result.code).not.toBe(0);
      expect(result.output).toContain("database_endpoint_invalid");
      expect(result.output).not.toContain(secret);
      expect(result.output).not.toContain(app);
    }
  });

  test("runtime credential derivation preserves the validated host, port, and database", () => {
    const owner = "postgres://owner:owner-secret@127.0.0.1:6543/minime";
    const app = derivePostgresCredentials(owner, "minime_app", "runtime-secret");
    const parsed = parseLocalPostgresUrl(app, "minime");
    expect(parsed.hostname).toBe("127.0.0.1");
    expect(parsed.port).toBe("6543");
    expect(decodeURIComponent(parsed.url.username)).toBe("minime_app");
    expect(decodeURIComponent(parsed.url.password)).toBe("runtime-secret");
  });
});
