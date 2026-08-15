import { beforeEach, describe, expect, test } from "bun:test";
import { stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ensurePerson, insertDecision, insertGoal, upsertPage, upsertTask } from "../src/db/repo";
import { compileDecisionDigests } from "../src/pipeline/decision-digest";
import { entityLinkPass } from "../src/pipeline/dream";
import { compileGoalDigests } from "../src/pipeline/goal-digest";
import { compileNotes } from "../src/pipeline/notes";
import { compileTopicClusters } from "../src/pipeline/topic-cluster";
import { parseWikilinks } from "../src/pipeline/wikilinks";
import { hybridSearch } from "../src/search/hybrid";
import { indexParent } from "../src/search/index-parent";
import { compiledNotePath } from "../src/util/compiled-note-archive";
import { config } from "../src/util/config";
import { resetDb, testSql as sql } from "./helpers";

async function pageMentioning(path: string, title: string, body: string, tier = 1): Promise<void> {
  const { id } = await upsertPage({ path, title, bodyMd: body, contentHash: `h:${path}`, tier });
  await indexParent("page", id, body, title, tier);
}

async function topicPage(kind: "decision" | "goal", id: string): Promise<any | null> {
  const [row] = await sql`select * from pages where path = ${`derived/topics/${kind}--${id}.md`}`;
  return row ?? null;
}

beforeEach(async () => {
  await resetDb();
});

describe("topic cluster pages", () => {
  test("clusters a decision digest with the mentioned person's compiled note", async () => {
    const { id: personId } = await ensurePerson("Ingrid Solberg", "test");
    await pageMentioning("journal/1.md", "1", "Ingrid Solberg joined the kelp survey.");
    await pageMentioning("journal/2.md", "2", "Ingrid Solberg calibrated the hydrophone.");
    await pageMentioning("journal/3.md", "3", "Ingrid Solberg wrote the field protocol.");
    await entityLinkPass();
    await compileNotes();
    const { id: decisionId } = await insertDecision({
      question: "Should we fund Ingrid Solberg's kelp survey expansion?",
      options: ["yes", "no"],
      createdBy: "test",
    });
    await compileDecisionDigests();
    const result = await compileTopicClusters();
    expect(result.compiled).toBe(1);
    const page = await topicPage("decision", decisionId);
    expect(page).not.toBeNull();
    expect(page.source).toBe("dream:topic-cluster");
    expect(page.created_by).toBe("system:dream");
    expect(page.derived_from).toBe(decisionId);
    expect(page.body_md).toContain("compiler: dream");
    expect(page.body_md).toContain(`- decision:${decisionId}`);
    const links = parseWikilinks(page.body_md);
    expect(links).toContain(`derived/decisions/${decisionId}.md`);
    expect(links).toContain(compiledNotePath("person", "Ingrid Solberg", personId));
    const archivePath = join(config.dataDir, "brain", page.path);
    expect((await stat(config.dataDir)).mode & 0o777).toBe(0o700);
    expect((await stat(dirname(archivePath))).mode & 0o777).toBe(0o700);
    expect((await stat(archivePath)).mode & 0o777).toBe(0o600);
  });

  test("a second run with no member change is unchanged", async () => {
    await ensurePerson("Sofia Reyes", "test");
    await pageMentioning("journal/a.md", "A", "Sofia Reyes joined the choir.");
    await pageMentioning("journal/b.md", "B", "Sofia Reyes baked the bread.");
    await pageMentioning("journal/c.md", "C", "Sofia Reyes ran the half marathon.");
    await entityLinkPass();
    await compileNotes();
    const { id: decisionId } = await insertDecision({
      question: "Invite Sofia Reyes to the winter concert committee?",
      options: ["yes", "later"],
      createdBy: "test",
    });
    await compileDecisionDigests();
    const first = await compileTopicClusters();
    expect(first.compiled).toBe(1);
    const before = await topicPage("decision", decisionId);
    const second = await compileTopicClusters();
    expect(second.compiled).toBe(0);
    const after = await topicPage("decision", decisionId);
    expect(after.updated_at.getTime()).toBe(before.updated_at.getTime());
  });

  test("a seed with only its own digest does not mint a singleton hub", async () => {
    const { id: decisionId } = await insertDecision({
      question: "Switch the lab notebook to paper?",
      options: ["yes", "no"],
      createdBy: "test",
    });
    await compileDecisionDigests();
    const result = await compileTopicClusters();
    expect(result.compiled).toBe(0);
    expect(await topicPage("decision", decisionId)).toBeNull();
  });

  test("goal hubs list wikilinks and never copy linked-task titles", async () => {
    const { id: personId } = await ensurePerson("Marek Dvorak", "test");
    await pageMentioning("journal/m1.md", "M1", "Marek Dvorak fixed the rig.");
    await pageMentioning("journal/m2.md", "M2", "Marek Dvorak called about the audit.");
    await pageMentioning("journal/m3.md", "M3", "Marek Dvorak is travelling next week.");
    await entityLinkPass();
    await compileNotes();
    const { id: goalId } = await insertGoal({
      horizon: "quarter",
      statement: "Keep Marek Dvorak on the calibration rota",
      why: "The field season needs a repeatable gel protocol.",
      createdBy: "test",
    });
    await upsertTask({
      title: "Order spare hydrophone nodes",
      createdBy: "test",
      goalId,
    });
    await compileGoalDigests();
    const result = await compileTopicClusters();
    expect(result.compiled).toBe(1);
    const page = await topicPage("goal", goalId);
    expect(page.body_md).toContain(`- goal:${goalId}`);
    expect(page.body_md).toContain(`[[derived/goals/${goalId}.md]]`);
    expect(page.body_md).toContain(`[[${compiledNotePath("person", "Marek Dvorak", personId)}]]`);
    expect(page.body_md).not.toContain("Order spare hydrophone nodes");
  });

  test("inherits the max member tier and stays hidden while locked", async () => {
    const { id: personId } = await ensurePerson("Nadia Rossi", "test");
    await pageMentioning("journal/n1.md", "N1", "Nadia Rossi drafted the private appendix.", 2);
    await pageMentioning("journal/n2.md", "N2", "Nadia Rossi redlined the launch memo.", 2);
    await pageMentioning("journal/n3.md", "N3", "Nadia Rossi scheduled the embargo call.", 2);
    await entityLinkPass();
    await compileNotes();
    const note =
      await sql`select tier from pages where path = ${compiledNotePath("person", "Nadia Rossi", personId)}`;
    expect(note[0]!.tier).toBe(2);
    const { id: goalId } = await insertGoal({
      horizon: "year",
      statement: "Finish the private appendix with Nadia Rossi",
      createdBy: "test",
    });
    await compileGoalDigests();
    await compileTopicClusters();
    const page = await topicPage("goal", goalId);
    expect(page.tier).toBe(2);
    const locked = await hybridSearch({
      query: "private appendix with Nadia Rossi",
      types: ["page", "goal"],
      includeDerived: true,
      limit: 5,
      actor: "agent:locked",
    });
    expect(locked.some((hit) => hit.id === page.id)).toBe(false);
  });
});
