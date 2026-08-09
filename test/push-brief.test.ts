// W3-11: local push channel for the counts-only morning brief (src/ops/push.ts), its
// BRIEF_CRON/NTFY_URL config surface, and serve.ts's lock-winner-only scheduling of it.
// No real notification is ever sent here: darwin/linux delivery goes through
// __setDeliverForTest, and the loopback-validation tests only import src/util/config (never
// serve.ts), so no HTTP call or OS notifier command is ever spawned.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { logEvent, stateSnapshot } from "../src/db/repo";
import { toolByName } from "../src/mcp/tools";
import { invokeTool } from "../src/mcp/tools/registry";
import { OPS_LOG_BASENAME } from "../src/ops/ops-log";
import {
  type BriefSnapshot,
  __setDeliverForTest,
  briefCounts,
  buildBriefText,
  deliverBrief,
} from "../src/ops/push";
import { type OwnerMaintenanceSchedule, startOwnerMaintenanceSchedule } from "../src/serve";
import { auditPayload } from "../src/util/audit-payload";
import { todayStr } from "../src/util/clock";
import { config, parseNtfyUrl } from "../src/util/config";
import { resetDb, testSql as sql } from "./helpers";

const ctx = { actor: "agent:test-harness" };
async function call(name: string, params: any) {
  const r = await invokeTool(toolByName(name), params, ctx);
  if (!r.ok) throw new Error(`${name} failed: ${r.error.code} ${r.error.message}`);
  return r.envelope;
}

describe("buildBriefText / briefCounts (pure, counts-only)", () => {
  const okSnapshot: BriefSnapshot = {
    calendar: [{ id: "a" }, { id: "b" }],
    tasks_due: [{ id: "c" }, { id: "d" }, { id: "e" }],
    decision_reviews_due: [{ id: "f" }],
    review_queue_open: 4,
    upcoming_dates: [],
    ops_health: { failed_steps: [] },
  };

  test("briefCounts extracts exactly the six fixed counts", () => {
    expect(briefCounts(okSnapshot)).toEqual({
      events: 2,
      tasksDue: 3,
      decisionReviews: 1,
      reviewItems: 4,
      upcomingDates: 0,
      maintenanceOk: true,
    });
  });

  test("renders the fixed template with maintenance OK", () => {
    expect(buildBriefText(okSnapshot)).toBe(
      "Minime: 2 events today, 3 tasks due, 1 decision reviews, 4 review items, " +
        "0 upcoming dates; maintenance OK",
    );
  });

  test("renders maintenance failed(steps) from ops_health's fixed step identifiers", () => {
    const failing: BriefSnapshot = {
      calendar: [],
      tasks_due: [],
      decision_reviews_due: [],
      review_queue_open: 0,
      upcoming_dates: [],
      ops_health: { failed_steps: ["1_embed_backlog", "4_stale"] },
    };
    expect(buildBriefText(failing)).toBe(
      "Minime: 0 events today, 0 tasks due, 0 decision reviews, 0 review items, " +
        "0 upcoming dates; maintenance failed(1_embed_backlog,4_stale)",
    );
  });

  test("adversarial: real seeded task/decision titles never appear in the rendered text", async () => {
    await resetDb();
    const taskSentinel = "push-brief-adversarial-task-sentinel-jacaranda-orbit";
    const decisionSentinel = "push-brief-adversarial-decision-sentinel-marmoset-eclipse";
    await call("minime_upsert_task", { title: taskSentinel, due: todayStr() });
    await call("minime_log_decision", {
      question: decisionSentinel,
      options: ["keep local", "switch provider"],
    });

    // Same call shape push.ts's real scheduler uses: no actor, so this always resolves the
    // deterministic tier-1 view (see serve.ts's comment on why) regardless of any owner
    // tier-2 unlock -- irrelevant here since the test never opens one, but exercising the
    // exact production call keeps this test meaningful for the real code path.
    const snapshot = await stateSnapshot();
    expect(snapshot.tasks_due.length).toBeGreaterThan(0); // fixture actually landed in scope
    expect(snapshot.decision_reviews_due.length).toBeGreaterThan(0);

    const text = buildBriefText(snapshot);
    expect(text).not.toContain(taskSentinel);
    expect(text).not.toContain(decisionSentinel);
    expect(text).not.toContain("jacaranda");
    expect(text).not.toContain("marmoset");
    expect(text).toMatch(
      /^Minime: \d+ events today, \d+ tasks due, \d+ decision reviews, \d+ review items, \d+ upcoming dates; maintenance (OK|failed\([^)]*\))$/,
    );
  });
});

describe("NTFY_URL (config load, I1 fail-closed loopback-only)", () => {
  test("parseNtfyUrl accepts exact loopback literals, canonicalizing scheme/host/case", () => {
    expect(parseNtfyUrl("http://localhost:2586/minime")).toBe("http://localhost:2586/minime");
    expect(parseNtfyUrl("http://127.0.0.1:2586/minime")).toBe("http://127.0.0.1:2586/minime");
    expect(parseNtfyUrl("http://[::1]:2586/minime")).toBe("http://[::1]:2586/minime");
    expect(parseNtfyUrl("https://LOCALHOST/topic")).toBe("https://localhost/topic");
    // WHATWG's own URL parser folds ambiguous numeric IPv4 spellings to the dotted-quad form
    // before hostname comparison -- no bypass via hex/octal/decimal/short forms.
    expect(parseNtfyUrl("http://0x7f.0.0.1/topic")).toBe("http://127.0.0.1/topic");
    expect(parseNtfyUrl("http://127.1/topic")).toBe("http://127.0.0.1/topic");
  });

  test("parseNtfyUrl rejects anything non-loopback, non-http(s), or unparseable", () => {
    for (const [url, rule] of [
      ["", "empty"],
      ["not-a-url", "syntax"],
      ["ftp://localhost/topic", "scheme"],
      ["http://ntfy.sh/minime", "non_loopback_host"],
      ["http://evil.example.com/topic", "non_loopback_host"],
      ["http://localhost.evil.example.com/topic", "non_loopback_host"],
      ["http://localhost@evil.example.com/topic", "non_loopback_host"],
      ["http://0.0.0.0/topic", "non_loopback_host"],
    ] as const) {
      expect(() => parseNtfyUrl(url)).toThrow(new RegExp(rule));
    }
  });

  // Subprocess spawn is required here (same technique as test/config.dotenv.test.ts's
  // loadConfigWith): config.ts validates NTFY_URL once at module load, so re-importing it in
  // this already-running process would hit the module cache instead of re-running that check.
  function loadConfigWithNtfyUrl(ntfyUrl: string): { code: number | null; output: string } {
    const proc = Bun.spawnSync(
      [process.execPath, "--no-env-file", "-e", 'await import("./src/util/config")'],
      {
        cwd: join(import.meta.dir, ".."),
        env: {
          NODE_ENV: "test",
          MINIME_SKIP_REPO_DOTENV: "1",
          ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
          DATABASE_URL: "postgres://owner:secret@localhost:5432/minime",
          MINIME_APP_DATABASE_URL: "postgres://owner:secret@localhost:5432/minime",
          NTFY_URL: ntfyUrl,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    return { code: proc.exitCode, output: proc.stdout.toString() + proc.stderr.toString() };
  }

  test("a loopback NTFY_URL does not block serve startup", () => {
    expect(loadConfigWithNtfyUrl("http://localhost:2586/minime").code).toBe(0);
  });

  test("a non-localhost NTFY_URL fails serve startup validation with a clear error", () => {
    for (const url of [
      "http://ntfy.sh/minime",
      "http://evil.example.com/topic",
      "http://localhost.evil.example.com/topic",
    ]) {
      const result = loadConfigWithNtfyUrl(url);
      expect(result.code).not.toBe(0);
      expect(result.output).toContain("NTFY_URL is invalid");
      expect(result.output).toContain("non_loopback_host");
    }
  });
});

describe("push:brief audit payload (counts only)", () => {
  test("auditPayload.pushBrief keeps only the six fixed count/boolean fields", async () => {
    const payload = auditPayload.pushBrief({
      events: 2,
      tasksDue: 3,
      decisionReviews: 1,
      reviewItems: 4,
      upcomingDates: 0,
      maintenanceOk: true,
    });
    // Cast away the AuditPayload brand for the structural comparison only -- same as every
    // other direct-constructor check in test/audit-payload.test.ts (there via `as any` on the
    // whole module import); logEvent below still receives the properly branded `payload`.
    expect(payload as unknown as Record<string, unknown>).toEqual({
      events: 2,
      tasks_due: 3,
      decision_reviews: 1,
      review_items: 4,
      upcoming_dates: 0,
      maintenance_ok: true,
    });

    const eventId = await logEvent({ actor: "system:push", verb: "push:brief", payload });
    const [row] = await sql`select payload from events where id = ${eventId}::bigint`;
    expect(row!.payload).toEqual({
      events: 2,
      tasks_due: 3,
      decision_reviews: 1,
      review_items: 4,
      upcoming_dates: 0,
      maintenance_ok: true,
    });
  });

  test("rejects non-numeric/non-boolean fields", () => {
    expect(() =>
      auditPayload.pushBrief({
        events: "2" as any,
        tasksDue: 3,
        decisionReviews: 1,
        reviewItems: 4,
        upcomingDates: 0,
        maintenanceOk: true,
      }),
    ).toThrow("invalid_audit_payload");
    expect(() =>
      auditPayload.pushBrief({
        events: 2,
        tasksDue: 3,
        decisionReviews: 1,
        reviewItems: 4,
        upcomingDates: 0,
        maintenanceOk: "true" as any,
      }),
    ).toThrow("invalid_audit_payload");
  });
});

describe("deliverBrief (injected notifier only -- never a real notification in tests)", () => {
  afterEach(() => __setDeliverForTest(undefined));

  test("reports ok:true when the injected notifier succeeds", async () => {
    let received: string | undefined;
    __setDeliverForTest(async (text) => {
      received = text;
      return { ok: true };
    });
    const result = await deliverBrief(
      "Minime: 0 events today, 0 tasks due, 0 decision reviews, 0 review items, 0 upcoming dates; maintenance OK",
    );
    expect(result).toEqual({ ok: true });
    expect(received).toContain("Minime:");
  });

  test("reports ok:false when the injected notifier fails, without throwing", async () => {
    __setDeliverForTest(async () => ({ ok: false }));
    await expect(deliverBrief("anything")).resolves.toEqual({ ok: false });
  });
});

describe("serve schedules the push brief cron (W3-11)", () => {
  const original = {
    briefCron: config.briefCron,
    dreamCron: config.dreamCron,
    backupCron: config.backupCron,
    resticRepository: config.resticRepository,
    resticPasswordFile: config.resticPasswordFile,
    tz: config.tz,
    dataDir: config.dataDir,
  };
  const liveSchedules: OwnerMaintenanceSchedule[] = [];

  afterEach(async () => {
    await Promise.all(liveSchedules.splice(0).map((schedule) => schedule.close()));
    config.briefCron = original.briefCron;
    config.dreamCron = original.dreamCron;
    config.backupCron = original.backupCron;
    config.resticRepository = original.resticRepository;
    config.resticPasswordFile = original.resticPasswordFile;
    config.tz = original.tz;
    config.dataDir = original.dataDir;
    __setDeliverForTest(undefined);
  });

  interface FakeCronRegistration {
    pattern: string;
    fire: () => void;
  }

  // Same technique as test/maintenance-lock.test.ts's fakeCronFactory: record every cron the
  // scheduler tries to register instead of waiting out real cron intervals.
  function fakeCronFactory() {
    const registrations: FakeCronRegistration[] = [];
    const factory = (pattern: string, _options: { timezone: string }, callback: () => void) => {
      registrations.push({ pattern, fire: () => callback() });
      return { nextRun: () => null, stop: () => {} };
    };
    return { factory, registrations };
  }

  test("registers the push-brief cron only when BRIEF_CRON is set", async () => {
    config.tz = "Asia/Singapore";
    config.briefCron = "";
    const unconfigured = fakeCronFactory();
    const scheduleUnconfigured = await startOwnerMaintenanceSchedule(unconfigured.factory);
    try {
      expect(unconfigured.registrations.some((r) => r.pattern === "30 7 * * *")).toBe(false);
    } finally {
      await scheduleUnconfigured.close();
    }

    config.briefCron = "30 7 * * *";
    const configured = fakeCronFactory();
    const scheduleConfigured = await startOwnerMaintenanceSchedule(configured.factory);
    liveSchedules.push(scheduleConfigured);
    expect(configured.registrations.some((r) => r.pattern === "30 7 * * *")).toBe(true);
  });

  test("registers the push-brief cron only for the maintenance-lock winner", async () => {
    config.tz = "Asia/Singapore";
    config.briefCron = "30 7 * * *";

    const winner = fakeCronFactory();
    liveSchedules.push(await startOwnerMaintenanceSchedule(winner.factory));
    expect(winner.registrations.some((r) => r.pattern === "30 7 * * *")).toBe(true);

    const loser = fakeCronFactory();
    liveSchedules.push(await startOwnerMaintenanceSchedule(loser.factory));
    expect(loser.registrations.some((r) => r.pattern === "30 7 * * *")).toBe(false);
  });

  function freshDataDir(): string {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "minime-push-brief-test-")));
    config.dataDir = dir;
    return dir;
  }

  function opsLogPath(dir: string): string {
    return join(dir, "logs", OPS_LOG_BASENAME);
  }

  test("firing the cron builds and delivers the fixed counts template through the real pipeline", async () => {
    await resetDb();
    config.tz = "Asia/Singapore";
    config.briefCron = "30 7 * * *";
    let deliveredText: string | undefined;
    __setDeliverForTest(async (text) => {
      deliveredText = text;
      return { ok: true };
    });

    const { factory, registrations } = fakeCronFactory();
    const schedule = await startOwnerMaintenanceSchedule(factory);
    liveSchedules.push(schedule);
    const brief = registrations.find((r) => r.pattern === "30 7 * * *");
    expect(brief).toBeDefined();

    const before = await sql`select count(*)::int as n from events where verb = 'push:brief'`;
    brief!.fire();
    await schedule.close(); // waits for the fired task to fully settle

    expect(deliveredText).toMatch(
      /^Minime: \d+ events today, \d+ tasks due, \d+ decision reviews, \d+ review items, \d+ upcoming dates; maintenance (OK|failed\([^)]*\))$/,
    );
    const after = await sql`select count(*)::int as n from events where verb = 'push:brief'`;
    expect(after[0]!.n).toBe(before[0]!.n + 1);
  });

  test("a delivery failure logs to the local ops log via run(), without throwing out of the scheduler", async () => {
    await resetDb();
    config.tz = "Asia/Singapore";
    config.briefCron = "30 7 * * *";
    const dir = freshDataDir();
    __setDeliverForTest(async () => ({ ok: false }));

    const { factory, registrations } = fakeCronFactory();
    const schedule = await startOwnerMaintenanceSchedule(factory);
    liveSchedules.push(schedule);
    const brief = registrations.find((r) => r.pattern === "30 7 * * *");
    expect(brief).toBeDefined();

    brief!.fire();
    await schedule.close(); // does not throw/reject even though delivery failed

    const content = readFileSync(opsLogPath(dir), "utf8");
    expect(content).toContain("push brief");
    expect(content).toContain("class=Error");
    expect(content).not.toContain("push_brief_delivery_failed"); // never error.message

    // The audit event is still written -- counts are true regardless of delivery outcome.
    const [row] = await sql`
      select payload from events where verb = 'push:brief' order by at desc limit 1`;
    expect(Object.keys(row!.payload).sort()).toEqual(
      [
        "decision_reviews",
        "events",
        "maintenance_ok",
        "review_items",
        "tasks_due",
        "upcoming_dates",
      ].sort(),
    );
  });
});
