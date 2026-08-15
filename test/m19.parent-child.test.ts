// W8 spans: children stay the embed unit; envelope text is the heading section.
// Child sizing is unchanged (eval-calibration pending). No PMB/floor claim.
import { beforeAll, describe, expect, test } from "bun:test";
import { ftsCandidates, replaceChunks, upsertPage } from "../src/db/repo";
import { chunkMarkdown, chunkMarkdownSpans } from "../src/search/chunker";
import { snippet } from "../src/search/hybrid";
import { indexParent } from "../src/search/index-parent";
import { rechunkAll } from "../src/search/rechunk";
import { resetDb, testSql } from "./helpers";

const longPara = (prefix: string, n = 500) =>
  Array.from({ length: n }, (_, i) => `${prefix}${i}`).join(" ");

describe("chunkMarkdownSpans", () => {
  test("children match chunkMarkdown; one heading section is one span", () => {
    const md = `# Harbor\n\n${longPara("dock")}\n\n## Rope\n\n${longPara("coil")}`;
    const children = chunkMarkdown(md, "Notes");
    const spans = chunkMarkdownSpans(md, "Notes");
    expect(spans.flatMap((span) => span.children)).toEqual(children);
    expect(spans.length).toBe(2);
    expect(spans[0]!.text).toContain("Harbor");
    expect(spans[0]!.text).toContain("dock0");
    expect(spans[0]!.children.length).toBeGreaterThan(1);
  });

  test("short notes stay one span and one child", () => {
    const spans = chunkMarkdownSpans("Just a short note about coffee.", "Note");
    expect(spans).toHaveLength(1);
    expect(spans[0]!.children).toHaveLength(1);
    expect(spans[0]!.children[0]).toBe(spans[0]!.text);
  });
});

describe("span write + envelope text", () => {
  beforeAll(async () => {
    await resetDb();
  });

  test("indexParent writes span_id and search snippet uses span text", async () => {
    const md = `# Tidepool\n\n${longPara("tray")} The calibration window closed early.`;
    const { id } = await upsertPage({
      path: "notes/tidepool-span.md",
      title: "Tidepool trays",
      bodyMd: md,
      contentHash: "span-tidepool-1",
      createdBy: "test",
      source: "manual",
      tier: 1,
    });
    await indexParent("page", id, md, "Tidepool trays", 1, { extractEdges: false });
    const spans = await testSql`
      select id, ord, text from chunk_spans
      where parent_type = 'page' and parent_id = ${id}
      order by ord`;
    const chunks = await testSql`
      select ord, text, span_id from chunks
      where parent_type = 'page' and parent_id = ${id}
      order by ord`;
    expect(spans.length).toBe(1);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((row) => row.span_id === spans[0]!.id)).toBe(true);
    const hits = await ftsCandidates("calibration window", ["page"]);
    const mine = hits.find((hit) => hit.parent_id === id);
    expect(mine).toBeDefined();
    expect(mine!.span_text).toBe(spans[0]!.text);
    expect(snippet(mine!.span_text ?? mine!.text, "calibration window")).toContain("calibration");
  });

  test("rechunk rebuilds spans from the parent row", async () => {
    const { id } = await upsertPage({
      path: "notes/rechunk-span.md",
      title: "Rechunk demo",
      bodyMd: "Short body about the fictional kiln.",
      contentHash: "span-rechunk-1",
      createdBy: "test",
      source: "manual",
      tier: 1,
    });
    await replaceChunks("page", id, ["legacy child without a span"], 1);
    const before = await testSql`
      select span_id from chunks where parent_type = 'page' and parent_id = ${id}`;
    expect(before[0]!.span_id).toBeNull();
    const result = await rechunkAll();
    expect(result.parents).toBeGreaterThan(0);
    const after = await testSql`
      select c.span_id, s.text as span_text
      from chunks c join chunk_spans s on s.id = c.span_id
      where c.parent_type = 'page' and c.parent_id = ${id}`;
    expect(after).toHaveLength(1);
    expect(after[0]!.span_text).toContain("fictional kiln");
  });
});
