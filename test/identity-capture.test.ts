// First-class org/person inbox types. A dedicated identity capture files a
// resolvable orgs/people row (name+alias dedup) with name-only chunks — never a
// page, never the capture body. Fixtures are fictional.

import { beforeEach, describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { toolByName } from "../src/mcp/tools";
import { invokeTool } from "../src/mcp/tools/registry";
import {
  heuristicClassify,
  heuristicIdentityType,
  identityCaptureName,
} from "../src/pipeline/classify";
import { processInboxFile } from "../src/pipeline/watcher";
import { config } from "../src/util/config";
import { resetDb, testSql as sql } from "./helpers";
import { requestAndApproveTier2, sessionToolCtx } from "./support/unlock";

beforeEach(async () => {
  await resetDb();
});

async function writeInbox(name: string, body: string): Promise<string> {
  const inbox = join(config.dataDir, "inbox");
  await mkdir(inbox, { recursive: true });
  const path = join(inbox, name);
  await Bun.write(path, body);
  return path;
}

describe("heuristic identity capture", () => {
  test("hint org / company record classifies as org", () => {
    const text = "<!-- hint: org / company record -->\nFjordsonics AS\ncalibration gel supplier";
    expect(heuristicIdentityType(text)).toBe("org");
    expect(heuristicClassify(text)).toMatchObject({
      type: "org",
      fields: { name: "Fjordsonics AS" },
    });
  });

  test("hint person record classifies as person", () => {
    const text = "<!-- hint: person record -->\nNadia Rossi";
    expect(heuristicIdentityType(text)).toBe("person");
    expect(heuristicClassify(text).type).toBe("person");
    expect(identityCaptureName(text)).toBe("Nadia Rossi");
  });

  test("org: / person: prefixes classify as identities", () => {
    expect(heuristicClassify("org: Bluefin Labs AS").type).toBe("org");
    expect(heuristicClassify("company: Aster Bio AS").type).toBe("org");
    expect(heuristicClassify("person: Sigrid Halvorsen").fields.name).toBe("Sigrid Halvorsen");
    expect(heuristicIdentityType("<!-- hint: person -->\nSigrid Halvorsen")).toBe("person");
  });

  test("an unparseable identity name does not mint Unknown", () => {
    expect(heuristicClassify("org: !!").type).toBe("unknown");
    expect(identityCaptureName("org: !!")).toBeNull();
    expect(identityCaptureName("<!-- hint: org / company record -->\n42")).toBeNull();
  });

  test("todo and met cues still win over a company name in the body", () => {
    expect(heuristicClassify("todo: email Fjordsonics AS about the order").type).toBe("task");
    expect(heuristicClassify("met Tomasz about the calibration run").type).toBe("interaction");
  });

  test("a long note about a company without a hint stays a note", () => {
    const text =
      "Notes on the fictional calibration-gel market around Trondheim, including why Fjordsonics AS quotes differently from Bluefin Labs AS this quarter.";
    expect(heuristicClassify(text).type).toBe("note");
  });
});

describe("org/person inbox filing (e2e, classifier mocked)", () => {
  test("a dedicated org capture files an org row, not a page, with name-only chunks", async () => {
    const body =
      "<!-- hint: org / company record -->\nFjordsonics AS\nprivate narrative about the hydrophone quote";
    const path = await writeInbox("org-fjordsonics.md", body);
    const result = await processInboxFile(path);
    expect(result.filed).toBe(true);

    const [item] = await sql`
      select filed_table, filed_id from inbox_items where id = ${result.inboxId}`;
    expect(item!.filed_table).toBe("orgs");

    const [org] = await sql`
      select id, canonical_name, tier, source, derived_from, created_by
      from orgs where id = ${item!.filed_id}`;
    expect(org!.canonical_name).toBe("Fjordsonics AS");
    expect(org!.tier).toBe(1);
    expect(org!.source).toBe("capture");
    expect(org!.derived_from).toBe(result.inboxId);
    expect(org!.created_by).toBe("agent:classifier");

    const pages = await sql`select count(*)::int as n from pages`;
    expect(pages[0]!.n).toBe(0);

    const chunks = await sql`
      select text from chunks where parent_type = 'org' and parent_id = ${org!.id}`;
    expect(chunks.length).toBeGreaterThan(0);
    for (const chunk of chunks) {
      expect(String(chunk.text)).toContain("Fjordsonics");
      expect(String(chunk.text)).not.toContain("private narrative");
      expect(String(chunk.text)).not.toContain("hydrophone quote");
    }

    const ctx = await invokeTool(
      toolByName("minime_get_context"),
      { type: "org", id: org!.id },
      { actor: "agent:test" },
    );
    expect(ctx.ok).toBe(true);
    expect(
      (ctx as { envelope: { data: { row: { canonical_name: string } } } }).envelope.data.row
        .canonical_name,
    ).toBe("Fjordsonics AS");
  });

  test("an unparseable org: prefix stays unfiled and mints no org", async () => {
    const path = await writeInbox("org-bang.md", "org: !!");
    const result = await processInboxFile(path);
    expect(result.filed).toBe(false);
    const [n] = await sql`select count(*)::int as n from orgs`;
    expect(n!.n).toBe(0);
    const [item] =
      await sql`select status, filed_table from inbox_items where id = ${result.inboxId}`;
    expect(item!.status).toBe("pending");
    expect(item!.filed_table).toBeNull();
  });

  test("a dedicated person capture files a people row", async () => {
    const path = await writeInbox("person-nadia.md", "person: Nadia Rossi");
    const result = await processInboxFile(path);
    expect(result.filed).toBe(true);
    const [item] = await sql`
      select filed_table, filed_id from inbox_items where id = ${result.inboxId}`;
    expect(item!.filed_table).toBe("people");
    const [person] = await sql`
      select canonical_name, tier, source from people where id = ${item!.filed_id}`;
    expect(person).toEqual({ canonical_name: "Nadia Rossi", tier: 1, source: "capture" });
  });

  test("reuses an existing org by name and does not mint a twin", async () => {
    const [existing] = await sql`
      insert into orgs (canonical_name, created_by, source)
      values ('Fjordsonics AS', 'human', 'manual') returning id`;
    const path = await writeInbox("org-reuse.md", "org: Fjordsonics AS");
    const result = await processInboxFile(path);
    expect(result.filed).toBe(true);
    const [item] = await sql`
      select filed_id from inbox_items where id = ${result.inboxId}`;
    expect(item!.filed_id).toBe(existing!.id);
    const [n] = await sql`select count(*)::int as n from orgs`;
    expect(n!.n).toBe(1);
  });

  test("reuses an existing person by alias", async () => {
    const [existing] = await sql`
      insert into people (canonical_name, created_by, source)
      values ('Nadia Rossi', 'human', 'manual') returning id`;
    await sql`insert into person_aliases (person_id, alias) values (${existing!.id}, 'Nadia')`;
    const path = await writeInbox("person-alias.md", "person: Nadia");
    const result = await processInboxFile(path);
    expect(result.filed).toBe(true);
    const [item] = await sql`
      select filed_id from inbox_items where id = ${result.inboxId}`;
    expect(item!.filed_id).toBe(existing!.id);
    const [n] = await sql`select count(*)::int as n from people`;
    expect(n!.n).toBe(1);
  });
});

describe("minime_refile org/person", () => {
  test("refiles a pending capture as an org identity", async () => {
    const inbox = join(config.dataDir, "inbox");
    await mkdir(inbox, { recursive: true });
    const path = join(inbox, "zqx-refile-org.md");
    await Bun.write(path, "unclear: ZQX-REFILE-ORG fictional vendor card");
    const { inboxId, filed } = await processInboxFile(path);
    expect(filed).toBe(false);

    const ctx = sessionToolCtx("agent:refile-org");
    await requestAndApproveTier2(ctx);
    const result = await invokeTool(
      toolByName("minime_refile"),
      { inbox_item_id: inboxId, type: "org", title: "Aster Bio AS" },
      ctx,
    );
    expect(result.ok).toBe(true);
    const data = (result as { envelope: { data: { filed_table: string; filed_id: string } } })
      .envelope.data;
    expect(data.filed_table).toBe("orgs");
    const [org] = await sql`
      select canonical_name, created_by, source from orgs where id = ${data.filed_id}`;
    expect(org!.canonical_name).toBe("Aster Bio AS");
    expect(org!.created_by).toBe(ctx.actor);
    expect(org!.source).toBe("capture");
    const chunks = await sql`
      select text from chunks where parent_type = 'org' and parent_id = ${data.filed_id}`;
    for (const chunk of chunks) {
      expect(String(chunk.text)).not.toContain("ZQX-REFILE-ORG");
    }
  });

  test("refile as org without a usable name is BAD_INPUT and mints nothing", async () => {
    const inbox = join(config.dataDir, "inbox");
    await mkdir(inbox, { recursive: true });
    const path = join(inbox, "zqx-refile-org-noname.md");
    await Bun.write(path, "unclear: ZQX-REFILE-ORG-NONAME fictional vendor card");
    const { inboxId, filed } = await processInboxFile(path);
    expect(filed).toBe(false);

    const ctx = sessionToolCtx("agent:refile-org-noname");
    await requestAndApproveTier2(ctx);
    const missing = await invokeTool(
      toolByName("minime_refile"),
      { inbox_item_id: inboxId, type: "org" },
      ctx,
    );
    expect(missing.ok).toBe(false);
    expect((missing as { error: { code: string } }).error.code).toBe("BAD_INPUT");

    const junk = await invokeTool(
      toolByName("minime_refile"),
      { inbox_item_id: inboxId, type: "org", title: "!!" },
      ctx,
    );
    expect(junk.ok).toBe(false);
    expect((junk as { error: { code: string } }).error.code).toBe("BAD_INPUT");

    const [n] = await sql`select count(*)::int as n from orgs`;
    expect(n!.n).toBe(0);
    const [item] = await sql`select status from inbox_items where id = ${inboxId}`;
    expect(item!.status).toBe("pending");
  });
});
