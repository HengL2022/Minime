// W3-10: person_dates table (birthdays/anniversaries/custom recurring dates) + minime_state's
// upcoming_dates (next 14 days) + minime_set_person_date. Covers: upsert idempotency on the
// (person_id, kind, label) unique key; next-occurrence math across a year wrap and the documented
// Feb-29-in-a-non-leap-year clamp choice; tier gating (date attached to a tier-2 person is
// invisible at tier 1); the tool's NOT_FOUND wording; minime_state always carries upcoming_dates;
// and person_dates' own RLS (minime_app cannot read a manually tier-2 row without an unlock).
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { ensurePerson, upcomingPersonDates, upsertPersonDate } from "../src/db/repo";
import { toolByName } from "../src/mcp/tools";
import { type ToolResult, invokeTool } from "../src/mcp/tools/registry";
import { setNow } from "../src/util/clock";
import { resetDb, testSql } from "./helpers";
import { dropTestAppRole, mintTestAppRole } from "./support/app-role";
import { requestAndApproveTier2, sessionToolCtx } from "./support/unlock";

type Ctx = ReturnType<typeof sessionToolCtx>;

function setDate(ctx: Ctx, params: Record<string, unknown>): Promise<ToolResult> {
  return invokeTool(toolByName("minime_set_person_date"), params, ctx);
}

function state(ctx: Ctx): Promise<ToolResult> {
  return invokeTool(toolByName("minime_state"), {}, ctx);
}

function expectOk(result: ToolResult): Record<string, any> {
  if (!result.ok)
    throw new Error(`expected success, got ${result.error.code}: ${result.error.message}`);
  return result.envelope.data as Record<string, any>;
}

function expectErr(result: ToolResult): { code: string; message: string } {
  if (result.ok) throw new Error("expected failure, got success");
  return result.error;
}

// UTC noon keeps the local calendar day equal to the UTC day in every real-world timezone, so
// these tests are not sensitive to whatever config.tz happens to be in the test environment.
function noonUtc(year: number, month1to12: number, day: number): Date {
  return new Date(Date.UTC(year, month1to12 - 1, day, 12, 0, 0));
}

beforeAll(async () => {
  await resetDb();
});

afterEach(() => setNow(null));

describe("minime_set_person_date: upsert idempotency", () => {
  test("re-setting the same person+kind updates the one row instead of minting a duplicate", async () => {
    const ctx = sessionToolCtx("agent:pd-idempotent-birthday");
    const { id: personId } = await ensurePerson(
      "Fictional Idem Birthday Person",
      "human",
      "manual",
      {
        tier: 1,
      },
    );

    const first = expectOk(
      await setDate(ctx, { person_id: personId, kind: "birthday", month: 3, day: 3 }),
    );
    const second = expectOk(
      await setDate(ctx, { person_id: personId, kind: "birthday", month: 3, day: 10, year: 1990 }),
    );
    expect(second.person_date_id).toBe(first.person_date_id);

    const rows = await testSql`
      select month, day, year from person_dates
      where person_id = ${personId}::uuid and kind = 'birthday'`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.month).toBe(3);
    expect(rows[0]!.day).toBe(10);
    expect(rows[0]!.year).toBe(1990);
  });

  test("custom dates are idempotent per label; a different label is a separate date, not a duplicate", async () => {
    const ctx = sessionToolCtx("agent:pd-idempotent-custom");
    const { id: personId } = await ensurePerson("Fictional Idem Custom Person", "human", "manual", {
      tier: 1,
    });

    expectOk(
      await setDate(ctx, {
        person_id: personId,
        kind: "custom",
        label: "House purchase",
        month: 6,
        day: 1,
      }),
    );
    expectOk(
      await setDate(ctx, {
        person_id: personId,
        kind: "custom",
        label: "House purchase",
        month: 6,
        day: 2,
      }),
    );
    expectOk(
      await setDate(ctx, {
        person_id: personId,
        kind: "custom",
        label: "Mom's memorial",
        month: 9,
        day: 12,
      }),
    );

    const rows = await testSql`
      select label, day from person_dates
      where person_id = ${personId}::uuid and kind = 'custom' order by label`;
    expect(rows.map((row) => ({ ...row }))).toEqual([
      { label: "House purchase", day: 2 },
      { label: "Mom's memorial", day: 12 },
    ]);
  });
});

describe("upcomingPersonDates: next-occurrence math", () => {
  test("year wrap: a Dec 28 today with a Jan 5 birthday resolves to next year's Jan 5 and is caught by the 14-day window", async () => {
    const { id: nearId } = await ensurePerson("Fictional Wrap Near Person", "human", "manual", {
      tier: 1,
    });
    const { id: farId } = await ensurePerson("Fictional Wrap Far Person", "human", "manual", {
      tier: 1,
    });
    await upsertPersonDate({ personId: nearId, kind: "birthday", month: 1, day: 5 });
    // Well outside the 14-day window from Dec 28 (window ends Jan 10) -- negative control that
    // the window actually filters, not just that the year-wrap math resolves a date.
    await upsertPersonDate({ personId: farId, kind: "birthday", month: 1, day: 20 });

    const rows = await upcomingPersonDates("2026-12-28", 14);
    const near = rows.find((r) => r.person_id === nearId);
    const far = rows.find((r) => r.person_id === farId);
    expect(near).toBeDefined();
    expect(new Date(near!.date).toISOString().slice(0, 10)).toBe("2027-01-05");
    expect(far).toBeUndefined();
  });

  test("Feb 29 birthday surfaces on Feb 28 in a non-leap year (documented clamp choice), and stays Feb 29 in a leap year", async () => {
    const { id: personId } = await ensurePerson("Fictional Leap Person", "human", "manual", {
      tier: 1,
    });
    await upsertPersonDate({ personId, kind: "birthday", month: 2, day: 29 });

    // 2026 is not a leap year (not divisible by 4); the window [Feb20, Mar5] contains Feb 28.
    const nonLeap = await upcomingPersonDates("2026-02-20", 14);
    const nonLeapHit = nonLeap.find((r) => r.person_id === personId);
    expect(nonLeapHit).toBeDefined();
    expect(new Date(nonLeapHit!.date).toISOString().slice(0, 10)).toBe("2026-02-28");

    // 2028 IS a leap year; the same person's Feb 29 is not clamped there.
    const leap = await upcomingPersonDates("2028-02-20", 14);
    const leapHit = leap.find((r) => r.person_id === personId);
    expect(leapHit).toBeDefined();
    expect(new Date(leapHit!.date).toISOString().slice(0, 10)).toBe("2028-02-29");
  });
});

describe("minime_set_person_date: NOT_FOUND / BAD_INPUT", () => {
  test("NOT_FOUND wording is identical whether resolution failed by name or by id", async () => {
    const ctx = sessionToolCtx("agent:pd-notfound");
    const byName = expectErr(
      await setDate(ctx, {
        person_name: "Fictional Nobody At All",
        kind: "birthday",
        month: 1,
        day: 1,
      }),
    );
    expect(byName.code).toBe("NOT_FOUND");
    expect(byName.message).toContain("not found or above current access tier");

    const byId = expectErr(
      await setDate(ctx, { person_id: crypto.randomUUID(), kind: "birthday", month: 1, day: 1 }),
    );
    expect(byId.code).toBe("NOT_FOUND");
    expect(byId.message).toContain("not found or above current access tier");
  });

  test("BAD_INPUT: no selector, kind=custom missing a label, and a non-custom kind carrying one", async () => {
    const ctx = sessionToolCtx("agent:pd-badinput");
    const { id: personId } = await ensurePerson("Fictional BadInput Person", "human", "manual", {
      tier: 1,
    });

    expect(expectErr(await setDate(ctx, { kind: "birthday", month: 1, day: 1 })).code).toBe(
      "BAD_INPUT",
    );
    expect(
      expectErr(await setDate(ctx, { person_id: personId, kind: "custom", month: 1, day: 1 })).code,
    ).toBe("BAD_INPUT");
    expect(
      expectErr(
        await setDate(ctx, {
          person_id: personId,
          kind: "anniversary",
          label: "should not be allowed",
          month: 1,
          day: 1,
        }),
      ).code,
    ).toBe("BAD_INPUT");
  });
});

describe("tier gating and minime_state integration", () => {
  test("acceptance: a birthday set via the tool shows up under minime_state's upcoming_dates within the 14-day window", async () => {
    const ctx = sessionToolCtx("agent:pd-acceptance");
    const { id: personId } = await ensurePerson("Fictional Alice Acceptance", "human", "manual", {
      tier: 1,
    });
    setNow(noonUtc(2026, 2, 25)); // 6 days before March 3 -- well inside a 14-day window

    expectOk(
      await setDate(ctx, {
        person_name: "Fictional Alice Acceptance",
        kind: "birthday",
        month: 3,
        day: 3,
      }),
    );

    const data = expectOk(await state(ctx));
    expect(Array.isArray(data.upcoming_dates)).toBe(true);
    const hit = data.upcoming_dates.find((d: any) => d.person_id === personId);
    expect(hit).toBeDefined();
    expect(hit.kind).toBe("birthday");
    expect(hit.canonical_name).toBe("Fictional Alice Acceptance");
    expect(hit.label).toBeNull();
  });

  test("minime_state always carries an upcoming_dates array, even with nothing due", async () => {
    const ctx = sessionToolCtx("agent:pd-empty-state");
    const data = expectOk(await state(ctx));
    expect(Array.isArray(data.upcoming_dates)).toBe(true);
  });

  test("a date attached to a tier-2 person is invisible at tier 1 and visible only after an unlock", async () => {
    const ownerCtx = sessionToolCtx("agent:pd-tier-owner");
    await requestAndApproveTier2(ownerCtx);
    const interactionData = expectOk(
      await invokeTool(
        toolByName("minime_log_interaction"),
        {
          person_name: "Fictional Hidden Birthday Person",
          kind: "note",
          summary: "Fictional hidden note.",
        },
        ownerCtx,
      ),
    );
    const [interactionRow] = await testSql`
      select person_id from interactions where id = ${interactionData.interaction_id}::uuid`;
    const hiddenPersonId = interactionRow!.person_id as string;
    const [personRow] = await testSql`select tier from people where id = ${hiddenPersonId}::uuid`;
    expect(personRow!.tier).toBe(2); // repro precondition: log_interaction always tiers 2

    setNow(noonUtc(2026, 5, 5));
    expectOk(
      await setDate(ownerCtx, { person_id: hiddenPersonId, kind: "birthday", month: 5, day: 5 }),
    );
    const [dateRow] = await testSql`
      select tier from person_dates where person_id = ${hiddenPersonId}::uuid`;
    expect(dateRow!.tier).toBe(1); // the date row itself is ordinary tier 1

    const lockedCtx = sessionToolCtx("agent:pd-tier-locked"); // no unlock on this session
    const lockedData = expectOk(await state(lockedCtx));
    expect(
      lockedData.upcoming_dates.find((d: any) => d.person_id === hiddenPersonId),
    ).toBeUndefined();

    const unlockedData = expectOk(await state(ownerCtx));
    const visible = unlockedData.upcoming_dates.find((d: any) => d.person_id === hiddenPersonId);
    expect(visible).toBeDefined();
    expect(visible.canonical_name).toBe("Fictional Hidden Birthday Person");
  });
});

describe("person_dates RLS (minime_app boundary)", () => {
  let appRole: Awaited<ReturnType<typeof mintTestAppRole>>;
  let app: ReturnType<typeof postgres>;

  beforeAll(async () => {
    appRole = await mintTestAppRole(process.env.DATABASE_URL!);
    app = postgres(appRole.databaseUrl, { max: 1, onnotice: () => {} });
  });

  afterAll(async () => {
    await app?.end({ timeout: 2 });
    if (appRole) await dropTestAppRole(appRole);
  });

  test("minime_app can read a tier-1 row but not a manually tier-2 row without an unlock", async () => {
    const { id: personId } = await ensurePerson("Fictional RLS Person", "human", "manual", {
      tier: 1,
    });
    const [tierOne] = await testSql`
      insert into person_dates (person_id, kind, month, day, tier, created_by, source)
      values (${personId}::uuid, 'birthday', 6, 15, 1, 'fixture', 'test')
      returning id`;
    await testSql`
      insert into person_dates (person_id, kind, month, day, tier, created_by, source)
      values (${personId}::uuid, 'anniversary', 7, 20, 2, 'fixture', 'test')`;

    const visible = await app`
      select id from person_dates where person_id = ${personId}::uuid order by id`;
    expect(visible.map((row) => row.id)).toEqual([tierOne!.id]);
  });
});
