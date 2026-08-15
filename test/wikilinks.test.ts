import { beforeEach, describe, expect, test } from "bun:test";
import { upsertPage } from "../src/db/repo";
import {
  normalizeWikilinkTarget,
  parseWikilinks,
  resolveWikilinkTargets,
} from "../src/pipeline/wikilinks";
import { compiledNotePath } from "../src/util/compiled-note-archive";
import { resetDb } from "./helpers";

beforeEach(async () => {
  await resetDb();
});

describe("wikilink parser", () => {
  test("extracts path and slug targets and ignores title-shaped text", () => {
    const body = [
      "See [[derived/decisions/11111111-1111-4111-8111-111111111111.md]]",
      "and [[ingrid-solberg--22222222-2222-4222-8222-222222222222]]",
      "but not [[Ingrid Solberg]] or [[]]",
    ].join("\n");
    expect(parseWikilinks(body)).toEqual([
      "derived/decisions/11111111-1111-4111-8111-111111111111.md",
      "ingrid-solberg--22222222-2222-4222-8222-222222222222",
      "Ingrid Solberg",
    ]);
    expect(
      normalizeWikilinkTarget("derived/decisions/11111111-1111-4111-8111-111111111111.md"),
    ).toEqual({
      kind: "path",
      value: "derived/decisions/11111111-1111-4111-8111-111111111111.md",
    });
    expect(normalizeWikilinkTarget("ingrid-solberg--22222222-2222-4222-8222-222222222222")).toEqual(
      {
        kind: "slug",
        value: "22222222-2222-4222-8222-222222222222",
      },
    );
    expect(normalizeWikilinkTarget("Ingrid Solberg")).toBeNull();
    expect(normalizeWikilinkTarget("../secret.md")).toBeNull();
    expect(normalizeWikilinkTarget("/etc/passwd.md")).toBeNull();
  });
});

describe("wikilink resolver", () => {
  test("resolves exact paths and compiled-note slug--uuid, never titles", async () => {
    const entityId = "22222222-2222-4222-8222-222222222222";
    const path = compiledNotePath("person", "Ingrid Solberg", entityId);
    const { id } = await upsertPage({
      path,
      title: "Ingrid Solberg",
      bodyMd: "# Ingrid Solberg\n",
      contentHash: "h:wikilink",
      source: "dream:notes",
      createdBy: "system:dream",
    });
    const resolved = await resolveWikilinkTargets([
      path,
      `ingrid-solberg--${entityId}`,
      "Ingrid Solberg",
      "missing/page.md",
    ]);
    expect(resolved).toEqual([
      { target: path, path, id },
      { target: `ingrid-solberg--${entityId}`, path, id },
    ]);
  });
});
