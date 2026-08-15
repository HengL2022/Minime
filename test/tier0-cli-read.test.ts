// W4-5: owner-terminal-only tier-0 reads (`tx list`, `health list`) — never reachable through
// MCP (I2 "one door" + I3's tier-0 floor). Function-level tests exercise repo.ts's
// listTransactions/listHealthSamples directly against seeded fictional rows; CLI-subprocess
// tests exercise src/cli.ts's own TTY gate and count-only audit trail end to end, the same
// Bun.spawn pattern test/entity-tier-restore.test.ts uses for its owner-CLI-only command — a
// piped child stdout is never a TTY, deterministically, regardless of how `bun test` itself was
// invoked, so the refusal path needs no fragile process.stdout.isTTY monkey-patching.

import { beforeAll, describe, expect, test } from "bun:test";
import { withAdminDbTransaction } from "../src/db/client";
import { listHealthSamples, listTransactions } from "../src/db/repo";
import { resetDb, testSql } from "./helpers";

describe("tier-0 CLI reads (W4-5)", () => {
  beforeAll(async () => {
    await resetDb();
  });

  test("(1) listTransactions filters by month, ilike-matches merchant/category with LIKE-metachar escaping, and never drops a null-merchant row from an unfiltered listing", async () => {
    const [inA, inB, inC, inNull, outPrevMonth, outNextMonth] = await testSql`
      insert into transactions
        (occurred_at, amount_cents, currency, merchant, category, account_label, external_ref, created_by, source, tier)
      values
        ('2026-08-05', -1234, 'USD', 'Fictional Amazon 100%_off Deal', 'Shopping', 'Checking', 'tier0-cli-tx-a', 'test', 'test', 0),
        ('2026-08-06', -500,  'USD', 'Fictional Amazon 100Xoff Deal', 'Shopping', 'Checking', 'tier0-cli-tx-b', 'test', 'test', 0),
        ('2026-08-07', -999,  'USD', 'Fictional Cafe', 'Dining', 'Checking', 'tier0-cli-tx-c', 'test', 'test', 0),
        ('2026-08-08', -50,   'USD', null, null, 'Checking', 'tier0-cli-tx-null', 'test', 'test', 0),
        ('2026-07-31', -111,  'USD', 'Fictional Amazon 100%_off Deal', 'Shopping', 'Checking', 'tier0-cli-tx-prev', 'test', 'test', 0),
        ('2026-09-01', -222,  'USD', 'Fictional Amazon 100%_off Deal', 'Shopping', 'Checking', 'tier0-cli-tx-next', 'test', 'test', 0)
      returning id`;

    const monthRows = await withAdminDbTransaction(() => listTransactions({ month: "2026-08" }));
    expect(new Set(monthRows.map((r) => r.id))).toEqual(
      new Set([inA!.id, inB!.id, inC!.id, inNull!.id]),
    );
    expect(monthRows.some((r) => r.id === outPrevMonth!.id)).toBe(false);
    expect(monthRows.some((r) => r.id === outNextMonth!.id)).toBe(false);
    // A null merchant AND category must not vanish from an unfiltered (no --match) listing —
    // the boolean-gated predicate never evaluates the ilike side of the OR when no match was
    // requested, so it cannot turn a real NULL into a false exclusion.
    expect(monthRows.some((r) => r.id === inNull!.id)).toBe(true);

    // The LIKE-escape case from the spec: "100%_off" must match only the literal substring, not
    // "100" + any-run + any-single-char + "off" the way an unescaped ILIKE pattern would (which
    // inB's "100Xoff" satisfies: "100" + "" + "X" + "off").
    const escaped = await withAdminDbTransaction(() =>
      listTransactions({ month: "2026-08", match: "100%_off" }),
    );
    expect(escaped.map((r) => r.id)).toEqual([inA!.id]);
    expect(escaped[0]!.amountCents).toBe("-1234");
    expect(escaped[0]!.merchant).toBe("Fictional Amazon 100%_off Deal");

    // Category match, case-insensitive, and a match filter correctly excludes the null row.
    const categoryMatch = await withAdminDbTransaction(() =>
      listTransactions({ month: "2026-08", match: "dining" }),
    );
    expect(categoryMatch.map((r) => r.id)).toEqual([inC!.id]);

    const noHit = await withAdminDbTransaction(() =>
      listTransactions({ month: "2026-08", match: "no such fictional merchant" }),
    );
    expect(noHit).toEqual([]);

    // limit clamps the result set; an invalid limit is refused rather than silently coerced.
    const limited = await withAdminDbTransaction(() =>
      listTransactions({ month: "2026-08", limit: 1 }),
    );
    expect(limited).toHaveLength(1);
    await expect(
      withAdminDbTransaction(() => listTransactions({ month: "2026-08", limit: 0 })),
    ).rejects.toThrow("limit_invalid");
    await expect(
      withAdminDbTransaction(() => listTransactions({ month: "2026-13" })),
    ).rejects.toThrow("month_invalid");
    await expect(
      withAdminDbTransaction(() => listTransactions({ month: "not-a-month" })),
    ).rejects.toThrow("month_invalid");
  });

  test("(2) CLI subprocess: tx list audits count-only — never the match string or merchant text — and prints rows only under the test TTY-override seam", async () => {
    await testSql`
      insert into transactions
        (occurred_at, amount_cents, currency, merchant, category, account_label, external_ref, created_by, source, tier)
      values
        ('2026-05-10', -2500, 'USD', 'Fictional Grocer Sentinel', 'Groceries', 'Checking', 'tier0-cli-tx-audit-1', 'test', 'test', 0),
        ('2026-05-11', -800,  'USD', 'Fictional Grocer Sentinel Cafe', 'Dining', 'Checking', 'tier0-cli-tx-audit-2', 'test', 'test', 0)`;

    const result = await spawnTier0Cli(
      ["tx", "list", "--month", "2026-05", "--match", "Sentinel"],
      { MINIME_ALLOW_NON_TTY_TIER0: "1" },
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Fictional Grocer Sentinel");
    expect(result.stdout).toContain("Fictional Grocer Sentinel Cafe");
    expect(result.stdout).toContain("-25.00");
    expect(result.stdout).toContain("-- 2 transaction(s)");
    expect(`${result.stdout}\n${result.stderr}`).not.toContain("OLLAMA_URL");

    const [event] = await testSql`
      select payload from events where verb = 'cli:tx:list'
      and payload ->> 'month' = '2026-05' order by at desc limit 1`;
    expect(event!.payload).toEqual({ month: "2026-05", row_count: 2, match_used: true });
    expect(JSON.stringify(event!.payload)).not.toContain("Sentinel");
    expect(JSON.stringify(event!.payload)).not.toContain("Grocer");
  });

  test("(3) CLI subprocess: tx list refuses non-TTY stdout with a fixed message, prints nothing at all, yet still audits count-only", async () => {
    await testSql`
      insert into transactions
        (occurred_at, amount_cents, currency, merchant, category, account_label, external_ref, created_by, source, tier)
      values ('2026-04-10', -1500, 'USD', 'Fictional Refusal Sentinel', 'Shopping', 'Checking', 'tier0-cli-tx-refuse-1', 'test', 'test', 0)`;

    const result = await spawnTier0Cli(["tx", "list", "--month", "2026-04"]); // no TTY-override
    expect(result.code).toBe(4);
    expect(result.stderr).toContain("interactive terminal");
    expect(result.stdout).toBe(""); // renderTier0Lines's gate is the first thing it does
    expect(`${result.stdout}\n${result.stderr}`).not.toContain("Fictional Refusal Sentinel");
    expect(`${result.stdout}\n${result.stderr}`).not.toContain("OLLAMA_URL");

    const [event] = await testSql`
      select payload from events where verb = 'cli:tx:list'
      and payload ->> 'month' = '2026-04' order by at desc limit 1`;
    expect(event!.payload).toEqual({ month: "2026-04", row_count: 1, match_used: false });

    const ambient = await spawnTier0Cli(["tx", "list", "--month", "2026-04"], {
      NODE_ENV: "cli",
      MINIME_SKIP_REPO_DOTENV: "1",
      MINIME_ALLOW_NON_TTY_TIER0: "1",
    });
    expect(ambient.code).toBe(4);
    expect(ambient.stdout).toBe("");
    expect(`${ambient.stdout}\n${ambient.stderr}`).not.toContain("Fictional Refusal Sentinel");
  });

  test("(4) listHealthSamples filters by exact kind and an inclusive local-calendar-date range", async () => {
    const [inRange, outOfRange, wrongKind] = await testSql`
      insert into health_samples (kind, at, value, unit, created_by, source, tier)
      values
        ('steps', '2026-08-05 08:00:00+08', 8000, 'count', 'test', 'test', 0),
        ('steps', '2026-07-01 08:00:00+08', 5000, 'count', 'test', 'test', 0),
        ('sleep_minutes', '2026-08-05 08:00:00+08', 420, 'minutes', 'test', 'test', 0)
      returning id`;

    // test/setup.ts pins TZ=Asia/Singapore (+08, no DST) — these timestamps were inserted at
    // that same offset, so "local calendar date" and the literal date component agree exactly.
    const ranged = await withAdminDbTransaction(() =>
      listHealthSamples({ kind: "steps", from: "2026-08-01", to: "2026-08-31" }),
    );
    expect(ranged.map((r) => r.id)).toEqual([inRange!.id]);
    expect(ranged[0]!.value).toBe("8000");
    expect(ranged[0]!.unit).toBe("count");

    const allSteps = await withAdminDbTransaction(() => listHealthSamples({ kind: "steps" }));
    expect(new Set(allSteps.map((r) => r.id))).toEqual(new Set([inRange!.id, outOfRange!.id]));
    expect(allSteps.some((r) => r.id === wrongKind!.id)).toBe(false);

    await expect(
      withAdminDbTransaction(() => listHealthSamples({ kind: "Not Valid" })),
    ).rejects.toThrow("kind_invalid");
    await expect(
      withAdminDbTransaction(() => listHealthSamples({ kind: "steps", from: "2026-02-30" })),
    ).rejects.toThrow("from_invalid");
    await expect(
      withAdminDbTransaction(() => listHealthSamples({ kind: "steps", to: "not-a-date" })),
    ).rejects.toThrow("to_invalid");
  });

  test("(5) CLI subprocess: health list mirrors tx list's TTY gate and count-only audit", async () => {
    await testSql`
      insert into health_samples (kind, at, value, unit, created_by, source, tier)
      values ('weight_kg', '2026-06-15 07:00:00+08', 70.5, 'kg', 'test', 'test', 0)`;

    const allowed = await spawnTier0Cli(
      ["health", "list", "--kind", "weight_kg", "--from", "2026-06-01", "--to", "2026-06-30"],
      { MINIME_ALLOW_NON_TTY_TIER0: "1" },
    );
    expect(allowed.code).toBe(0);
    expect(allowed.stdout).toContain("70.5");
    expect(allowed.stdout).toContain("weight_kg");
    expect(allowed.stdout).toContain("-- 1 health sample(s)");

    const [event] = await testSql`
      select payload from events where verb = 'cli:health:list' order by at desc limit 1`;
    expect(event!.payload).toEqual({ kind: "weight_kg", row_count: 1, match_used: false });

    const refused = await spawnTier0Cli(["health", "list", "--kind", "weight_kg"]);
    expect(refused.code).toBe(4);
    expect(refused.stdout).toBe("");
    expect(`${refused.stdout}\n${refused.stderr}`).not.toContain("70.5");
  });

  test("(6) CLI subprocess: defensive argument validation never needs a DB fixture", async () => {
    const missingMonth = await spawnTier0Cli(["tx", "list"]);
    expect(missingMonth.code).toBe(2);
    expect(missingMonth.stderr).toContain("--month is required");

    const badLimit = await spawnTier0Cli(["tx", "list", "--month", "2026-08", "--limit", "0"], {
      MINIME_ALLOW_NON_TTY_TIER0: "1",
    });
    expect(badLimit.code).toBe(2);
    expect(badLimit.stderr).toContain("--limit must be a positive integer");

    const badMonth = await spawnTier0Cli(["tx", "list", "--month", "not-a-month"], {
      MINIME_ALLOW_NON_TTY_TIER0: "1",
    });
    expect(badMonth.code).toBe(2);
    expect(badMonth.stderr).toContain("--month must look like YYYY-MM");

    const missingKind = await spawnTier0Cli(["health", "list"]);
    expect(missingKind.code).toBe(2);
    expect(missingKind.stderr).toContain("--kind is required");
  });

  // grep-provable acceptance check (spec): "no console.log of tier-0 fields outside the
  // TTY-gated render function". Does not replace test (3)/(5)'s behavioral proof; pins the
  // source-level shape so a future edit cannot quietly add a second, ungated print path inside
  // the tx/health handlers themselves (cli.ts has plenty of unrelated console.log calls for
  // other commands, so this only inspects the slice between the two handlers and the
  // ollamaPreflight gate that follows them).
  test("(7) the tx/health command handlers never call console.log directly — only renderTier0Lines does, gated on isTTY as its first statement", async () => {
    const source = await Bun.file(new URL("../src/cli.ts", import.meta.url)).text();
    const start = source.indexOf('if (cmd === "tx" && process.argv[3] === "list")');
    const end = source.indexOf("const ollama = ollamaPreflight(config.ollamaUrl);");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const handlers = source.slice(start, end);
    expect(handlers).not.toContain("console.log(");
    expect(handlers.match(/renderTier0Lines\(lines\)/g)).toHaveLength(2); // tx and health each call it once

    const renderFnStart = source.indexOf("function renderTier0Lines(");
    expect(renderFnStart).toBeGreaterThan(-1);
    const renderFnHead = source.slice(renderFnStart, renderFnStart + 400);
    const isTtyOffset = renderFnHead.indexOf("isTTY");
    const consoleLogOffset = renderFnHead.indexOf("console.log");
    expect(isTtyOffset).toBeGreaterThan(-1);
    expect(consoleLogOffset).toBeGreaterThan(isTtyOffset); // gate precedes the only print
  });

  // W4-5 review finding: commit 2a420ab fixed the `audit` case (src/cli.ts) to actually render
  // month=/kind=/count=/match_used= for cli:tx:list/cli:health:list events, because docs/
  // GUIDE.md promises "minime audit shows the count, never what matched" — but nothing spawned
  // `bun run src/cli.ts audit` to prove the renderer does that. Tests (2)/(3)/(5) above only
  // assert the *stored* payload via direct SQL against `events`, never this render branch, so a
  // future edit to the case "audit" format-string logic could silently drop these fields again
  // with zero signal. This closes that gap end to end, through the real CLI subprocess.
  test("(8) CLI subprocess: `minime audit` prints month=/kind=/count=/match_used= for cli:tx:list and cli:health:list events, never the match text", async () => {
    await testSql`
      insert into transactions
        (occurred_at, amount_cents, currency, merchant, category, account_label, external_ref, created_by, source, tier)
      values ('2026-03-12', -700, 'USD', 'Fictional Audit Render Sentinel', 'Shopping', 'Checking', 'tier0-cli-tx-audit-render', 'test', 'test', 0)`;
    await testSql`
      insert into health_samples (kind, at, value, unit, created_by, source, tier)
      values ('resting_heart_rate', '2026-03-12 08:00:00+08', 58, 'bpm', 'test', 'test', 0)`;

    const tx = await spawnTier0Cli(["tx", "list", "--month", "2026-03"], {
      MINIME_ALLOW_NON_TTY_TIER0: "1",
    });
    expect(tx.code).toBe(0);

    const health = await spawnTier0Cli(
      [
        "health",
        "list",
        "--kind",
        "resting_heart_rate",
        "--from",
        "2026-03-01",
        "--to",
        "2026-03-31",
      ],
      { MINIME_ALLOW_NON_TTY_TIER0: "1" },
    );
    expect(health.code).toBe(0);

    // `audit` (case "audit", src/cli.ts) sits after the ollamaPreflight gate at cli.ts:563,
    // unlike tx/health list — it needs a syntactically valid loopback OLLAMA_URL to clear that
    // gate, overriding spawnTier0Cli's default "http://example.test:11434" (a non-loopback host
    // ollamaPreflight rejects with non_loopback_host); audit itself never talks to Ollama.
    const audit = await spawnTier0Cli(["audit", "--since", "1d"], {
      OLLAMA_URL: "http://localhost:11434",
    });
    expect(audit.code).toBe(0);
    expect(audit.stdout).toContain("cli:tx:list");
    expect(audit.stdout).toContain("month=2026-03 count=1 match_used=false");
    expect(audit.stdout).toContain("cli:health:list");
    expect(audit.stdout).toContain("kind=resting_heart_rate count=1 match_used=false");
    // The exact GUIDE.md promise this test guards: the count shows, the match/row text never does.
    expect(audit.stdout).not.toContain("Sentinel");
  });
});

async function spawnTier0Cli(
  args: string[],
  envOverrides: Record<string, string> = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = Bun.spawn([process.execPath, "--no-env-file", "run", "src/cli.ts", ...args], {
    cwd: new URL("..", import.meta.url).pathname,
    env: { ...process.env, OLLAMA_URL: "http://example.test:11434", ...envOverrides },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
}
