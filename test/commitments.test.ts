// W3-13: commitments live — promise capture via minime_log_interaction's optional `promise`
// param, minime_upsert_commitment's create/close path, and the migration-036 least-privilege
// commitments UPDATE grant. Mirrors goals-tool.test.ts's direct-invokeTool style and
// privacy-hardening.test.ts's tier-2 unlock pattern for the interaction-derived commitment.

import { beforeEach, describe, expect, test } from "bun:test";
import { toolByName } from "../src/mcp/tools";
import { invokeTool } from "../src/mcp/tools/registry";
import { hybridSearch } from "../src/search/hybrid";
import { resetDb, testSql as sql } from "./helpers";
import { requestAndApproveTier2, sessionToolCtx } from "./support/unlock";

const ctx = sessionToolCtx("agent:test-harness");
const call = async (name: string, params: Record<string, unknown>) => {
  const r = await invokeTool(toolByName(name), params, ctx);
  if (!r.ok) throw new Error(`${name} failed: ${r.error.code} ${r.error.message}`);
  return r.envelope;
};

beforeEach(async () => {
  await resetDb();
});

describe("minime_log_interaction: promise capture", () => {
  test("a promise made during a logged interaction opens a tier-2 commitment, derived from the interaction", async () => {
    const logged = await call("minime_log_interaction", {
      person_name: "COMMITSENTINEL Wei Jie",
      kind: "meeting",
      summary: "Discussed the settlement design doc.",
      promise: { what: "COMMITSENTINEL review the settlement design doc", due: "2026-09-01" },
    });
    const data = logged.data as any;
    expect(data.interaction_id).toBeString();
    expect(data.commitment_id).toBeString();
    expect(logged.sources).toEqual(
      expect.arrayContaining([
        { type: "interaction", id: data.interaction_id },
        { type: "commitment", id: data.commitment_id },
      ]),
    );

    const [row] = await sql`
      select what, to_whom, to_char(due, 'YYYY-MM-DD') as due, status, tier, derived_from,
             source, created_by
      from commitments where id = ${data.commitment_id}`;
    expect(row).toMatchObject({
      what: "COMMITSENTINEL review the settlement design doc",
      to_whom: "COMMITSENTINEL Wei Jie",
      due: "2026-09-01",
      status: "open",
      tier: 2,
      derived_from: data.interaction_id,
      source: "capture",
      created_by: "agent:test-harness",
    });
  });

  test("to_whom is the resolved canonical name, not the alias the caller typed", async () => {
    const [person] = await sql`
      insert into people (canonical_name, tier) values ('COMMITSENTINEL Sam Chen', 1)
      returning id`;
    await sql`
      insert into person_aliases (person_id, alias) values (${person!.id}, 'COMMITSENTINEL Sammy')`;

    const logged = await call("minime_log_interaction", {
      person_name: "COMMITSENTINEL Sammy",
      kind: "message",
      summary: "Pinged about the sensor order.",
      promise: { what: "COMMITSENTINEL send the sensor spec" },
    });
    const commitmentId = (logged.data as any).commitment_id;
    const [row] = await sql`select to_whom from commitments where id = ${commitmentId}`;
    expect(row!.to_whom).toBe("COMMITSENTINEL Sam Chen");
  });

  test("promise also works on the org branch (subject_type='org')", async () => {
    const logged = await call("minime_log_interaction", {
      person_name: "COMMITSENTINEL Fjordsonics",
      kind: "email",
      summary: "Quote request.",
      subject_type: "org",
      promise: { what: "COMMITSENTINEL send the PO" },
    });
    const data = logged.data as any;
    const [interaction] =
      await sql`select org_id from interactions where id = ${data.interaction_id}`;
    const [org] = await sql`select canonical_name from orgs where id = ${interaction!.org_id}`;
    const [commitment] =
      await sql`select to_whom, tier from commitments where id = ${data.commitment_id}`;
    expect(commitment!.to_whom).toBe(org!.canonical_name);
    expect(commitment!.tier).toBe(2);
  });

  test("no promise param leaves the receipt exactly {interaction_id}, unchanged", async () => {
    const logged = await call("minime_log_interaction", {
      person_name: "COMMITSENTINEL No Promise",
      kind: "call",
      summary: "Just a call, nothing promised.",
    });
    const data = logged.data as any;
    expect(Object.keys(data)).toEqual(["interaction_id"]);
    expect(logged.sources).toEqual([{ type: "interaction", id: data.interaction_id }]);
  });
});

describe("tier-2 visibility: a promise-derived commitment follows the interaction's own tier", () => {
  test("hidden from minime_state while locked; visible there and in the person dossier once unlocked", async () => {
    const logged = await call("minime_log_interaction", {
      person_name: "COMMITSENTINEL Tiered Person",
      kind: "meeting",
      summary: "Discussed timelines.",
      promise: { what: "COMMITSENTINEL send the timeline doc", due: "2026-09-15" },
    });
    const data = logged.data as any;

    const locked = await invokeTool(toolByName("minime_state"), {}, ctx);
    if (!locked.ok) throw new Error(locked.error.message);
    expect(
      (locked.envelope.data as any).commitments_open.some((c: any) => c.id === data.commitment_id),
    ).toBe(false);

    // W4-1 identity/content tier split: the interaction's subject mints at tier 1
    // (037_identity_content_tier_split.sql), so unlike before the split, a still-LOCKED
    // minime_get_context finds her identity card by name — it just doesn't show the tier-2
    // commitment (the generic tier-2-hides-commitments mechanism, a tier-1 person + tier-2
    // commitment, is covered in depth by privacy-hardening.test.ts; this just confirms the
    // interaction-minted subject specifically behaves the same way).
    const lockedDossier = await invokeTool(
      toolByName("minime_get_context"),
      { person_name: "COMMITSENTINEL Tiered Person" },
      ctx,
    );
    if (!lockedDossier.ok) throw new Error(lockedDossier.error.message);
    expect((lockedDossier.envelope.data as any).open_commitments).toEqual([]);

    await requestAndApproveTier2(ctx);

    const unlocked = await invokeTool(toolByName("minime_state"), {}, ctx);
    if (!unlocked.ok) throw new Error(unlocked.error.message);
    expect(
      (unlocked.envelope.data as any).commitments_open.some(
        (c: any) => c.id === data.commitment_id,
      ),
    ).toBe(true);

    // End-to-end person-dossier check, now unlocked: her commitment appears alongside her
    // already-visible (see lockedDossier above) identity card.
    const dossier = await invokeTool(
      toolByName("minime_get_context"),
      { person_name: "COMMITSENTINEL Tiered Person" },
      ctx,
    );
    if (!dossier.ok) throw new Error(dossier.error.message);
    expect(
      (dossier.envelope.data as any).open_commitments.some((c: any) => c.id === data.commitment_id),
    ).toBe(true);
  });
});

describe("minime_upsert_commitment: create", () => {
  test("creates a standalone tier-1 commitment, visible immediately (no unlock needed) and searchable", async () => {
    const created = await call("minime_upsert_commitment", {
      what: "COMMITSENTINEL water the office plants",
      to_whom: "COMMITSENTINEL Office",
      due: "2026-08-20",
    });
    const commitmentId = (created.data as any).commitment_id;
    expect(commitmentId).toBeString();

    const [row] =
      await sql`select what, to_whom, status, tier from commitments where id = ${commitmentId}`;
    expect(row).toMatchObject({
      what: "COMMITSENTINEL water the office plants",
      to_whom: "COMMITSENTINEL Office",
      status: "open",
      tier: 1,
    });

    const state = await invokeTool(toolByName("minime_state"), {}, ctx);
    if (!state.ok) throw new Error(state.error.message);
    expect(
      (state.envelope.data as any).commitments_open.some((c: any) => c.id === commitmentId),
    ).toBe(true);

    const hits = await hybridSearch({ query: "COMMITSENTINEL water office plants", limit: 5 });
    expect(hits.some((h) => h.id === commitmentId && h.type === "commitment")).toBe(true);
  });

  test("rejects a create call missing what or to_whom", async () => {
    const r = await invokeTool(
      toolByName("minime_upsert_commitment"),
      { what: "COMMITSENTINEL missing to_whom" },
      ctx,
    );
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected failure");
    expect(r.error.code).toBe("BAD_INPUT");
  });
});

describe("minime_upsert_commitment: id-only update / close", () => {
  test("closes an open commitment as kept, and it drops out of commitments_open", async () => {
    const created = await call("minime_upsert_commitment", {
      what: "COMMITSENTINEL send Hana the dates",
      to_whom: "COMMITSENTINEL Hana",
      due: "2026-08-10",
    });
    const commitmentId = (created.data as any).commitment_id;

    const closed = await call("minime_upsert_commitment", { id: commitmentId, status: "kept" });
    expect((closed.data as any).commitment_id).toBe(commitmentId);

    const [row] = await sql`select status, what from commitments where id = ${commitmentId}`;
    expect(row).toMatchObject({
      status: "kept",
      what: "COMMITSENTINEL send Hana the dates", // unchanged -- what/to_whom are immutable here
    });

    const state = await invokeTool(toolByName("minime_state"), {}, ctx);
    if (!state.ok) throw new Error(state.error.message);
    expect(
      (state.envelope.data as any).commitments_open.some((c: any) => c.id === commitmentId),
    ).toBe(false);
  });

  test("due is three-state: omitting the key keeps it, an explicit null clears it", async () => {
    const created = await call("minime_upsert_commitment", {
      what: "COMMITSENTINEL renegotiate the deadline",
      to_whom: "COMMITSENTINEL Priya",
      due: "2026-08-25",
    });
    const commitmentId = (created.data as any).commitment_id;

    await call("minime_upsert_commitment", { id: commitmentId, status: "renegotiated" });
    const [kept] = await sql`select due from commitments where id = ${commitmentId}`;
    expect(kept!.due).not.toBeNull();

    await call("minime_upsert_commitment", { id: commitmentId, due: null });
    const [cleared] = await sql`select due from commitments where id = ${commitmentId}`;
    expect(cleared!.due).toBeNull();
  });

  test("updating an unknown commitment id returns NOT_FOUND", async () => {
    const r = await invokeTool(
      toolByName("minime_upsert_commitment"),
      { id: crypto.randomUUID(), status: "kept" },
      ctx,
    );
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected failure");
    expect(r.error.code).toBe("NOT_FOUND");
  });
});

describe("superseded commitments are filtered from every read surface (028's columns, W3-13 fix)", () => {
  test("a superseded-but-still-open commitment is excluded from minime_state and the person dossier", async () => {
    await sql`
      insert into people (canonical_name, tier) values ('COMMITSENTINEL Superseded Person', 1)`;
    const [original] = await sql`
      insert into commitments (what, to_whom, status, tier)
      values ('COMMITSENTINEL superseded promise', 'COMMITSENTINEL Superseded Person', 'open', 1)
      returning id`;
    const [successor] = await sql`
      insert into commitments (what, to_whom, status, tier, supersedes_id)
      values ('COMMITSENTINEL successor promise', 'COMMITSENTINEL Superseded Person', 'open', 1,
              ${original!.id})
      returning id`;
    await sql`
      update commitments set superseded_by = ${successor!.id}, superseded_at = now()
      where id = ${original!.id}`;

    const state = await invokeTool(toolByName("minime_state"), {}, ctx);
    if (!state.ok) throw new Error(state.error.message);
    const stateIds = (state.envelope.data as any).commitments_open.map((c: any) => c.id);
    expect(stateIds).not.toContain(original!.id);
    expect(stateIds).toContain(successor!.id);

    const dossier = await invokeTool(
      toolByName("minime_get_context"),
      { person_name: "COMMITSENTINEL Superseded Person" },
      ctx,
    );
    if (!dossier.ok) throw new Error(dossier.error.message);
    const dossierIds = (dossier.envelope.data as any).open_commitments.map((c: any) => c.id);
    expect(dossierIds).not.toContain(original!.id);
    expect(dossierIds).toContain(successor!.id);
  });
});

describe("app-role least-privilege expansion (migration 036)", () => {
  test("minime_app has full table-wide UPDATE on commitments", async () => {
    const rows = await sql`
      select 1 from information_schema.role_table_grants
      where grantee = 'minime_app' and table_name = 'commitments' and privilege_type = 'UPDATE'`;
    expect(rows.length).toBe(1);
  });
});
