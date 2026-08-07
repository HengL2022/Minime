import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import {
  chmod,
  open as fsOpen,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  unlink,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  type AtomicFileOps,
  UNSAFE_PRIVATE_ROOT,
  assertDedicatedPrivateDataRoot,
  assertNoSymlinkComponents,
  atomicWritePrivate,
  createAtomicFileWriter,
  ensurePrivateDataRoot,
  preflightPrivateRoot,
} from "../src/util/atomic-file";
import {
  COMPILED_NOTE_MARKER,
  COMPILED_NOTE_SOURCE,
  COMPILED_NOTE_UUID_PATH_SQL_RE,
  compiledNoteIdentityFromPath,
  compiledNotePath,
  hasCompiledOwnershipEvidence,
  normalizeCompiledNoteBody,
  opaqueTargetHash,
  parseCompiledNoteArchive,
  parseCompiledNoteSourceIds,
  parseFrontmatterDocument,
  recognizeCompiledNote,
  renderCompiledNoteArchive,
  resolveCompiledNoteArchiveTarget,
} from "../src/util/compiled-note-archive";
import { REPO_ROOT, config } from "../src/util/config";

const PERSON_A = "11111111-2222-3333-4444-555555555555";
const PERSON_B = "22222222-3333-4444-5555-666666666666";

let privateRoots: string[] = [];
let globalOriginalDataDir = config.dataDir;
const PRIVATE_TMP = realpathSync(tmpdir());

async function withPrivateDataDir<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const original = config.dataDir;
  const root = await mkdtemp(join(PRIVATE_TMP, "minime-h1-note-"));
  privateRoots.push(root);
  await chmod(root, 0o700);
  config.dataDir = root;
  try {
    return await fn(root);
  } finally {
    config.dataDir = original;
    await rm(root, { recursive: true, force: true });
    privateRoots = privateRoots.filter((candidate) => candidate !== root);
  }
}

beforeEach(async () => {
  globalOriginalDataDir = config.dataDir;
  const root = await mkdtemp(join(PRIVATE_TMP, "minime-h1-note-test-"));
  privateRoots.push(root);
  await chmod(root, 0o700);
  config.dataDir = root;
});

afterEach(async () => {
  for (const root of privateRoots.splice(0)) await rm(root, { recursive: true, force: true });
  config.dataDir = globalOriginalDataDir;
});

describe("canonical compiled-note archive codec", () => {
  const titles = ['A: "quoted" \\ path / slash ---', "張偉 — Δοκιμή", "line one\nline two"];

  for (const title of titles) {
    test(`canonical title/body round-trip: ${JSON.stringify(title)}`, () => {
      const rendered = renderCompiledNoteArchive({
        title,
        tier: 2,
        bodyMd: "# Heading \r\nbody with two spaces  \r\n\r\n",
      });
      expect(rendered.text).toBe(
        `---\ntitle: ${JSON.stringify(title)}\ntier: 2\n---\n# Heading \nbody with two spaces  \n`,
      );
      expect(rendered.contentHash).toBe(createHash("sha256").update(rendered.bytes).digest("hex"));
      expect(parseCompiledNoteArchive(rendered.text)).toEqual(rendered);
    });
  }

  test("normalizes only CRLF, bare CR, and terminal newline characters", () => {
    expect(normalizeCompiledNoteBody("a \r\nb\r\n\r\n")).toBe("a \nb");
    expect(normalizeCompiledNoteBody("a\rb\r\r\n")).toBe("a\nb");
    expect(normalizeCompiledNoteBody("a  \n b ")).toBe("a  \n b ");
  });

  test("legacy plain and naively quoted titles still parse", () => {
    expect(parseFrontmatterDocument("---\ntitle: plain: title\ntier: 1\n---\nbody").title).toBe(
      "plain: title",
    );
    expect(parseFrontmatterDocument('---\ntitle: "legacy title"\ntier: 2\n---\nbody').title).toBe(
      "legacy title",
    );
    expect(parseFrontmatterDocument('---\ntitle: "unterminated\ntier: 2\n---\nbody').title).toBe(
      "unterminated",
    );
  });

  test("slug collisions are separated by the full entity UUID", () => {
    const a = compiledNotePath("person", "A/B", "11111111-1111-1111-1111-111111111111");
    const b = compiledNotePath("person", "A B", "22222222-2222-2222-2222-222222222222");
    expect(a).not.toBe(b);
    expect(compiledNoteIdentityFromPath(a)?.entityId).toBe("11111111-1111-1111-1111-111111111111");
  });

  test.each([
    ["A/B: C", PERSON_A, "a-b-c"],
    ["  --A..B-- ", PERSON_A, "a-b"],
    [`${"A".repeat(59)}!B`, PERSON_A, "a".repeat(59)],
    ["張偉 / …", PERSON_A, PERSON_A],
    ["../", PERSON_B, PERSON_B],
  ])("uses safe UUID-suffixed slug for %s", (readableName, entityId, slug) => {
    expect(compiledNotePath("person", readableName, entityId)).toBe(
      `derived/notes/person/${slug}--${entityId}.md`,
    );
  });

  test.each([
    "",
    "not-a-uuid",
    "11111111-1111-1111-1111-11111111111Z",
    "abcdefab-cdef-abcd-efab-cdefabcdefAB",
  ])("rejects noncanonical entity UUID %s before returning a path", (entityId) => {
    expect(() => compiledNotePath("person", "safe", entityId)).toThrow();
  });

  test("generated path has no traversal components and exported SQL regex is canonical", () => {
    const path = compiledNotePath("org", "a/../b\\c.d", PERSON_A);
    expect(path).toMatch(/^derived\/notes\/org\/[a-z0-9-]+--[0-9a-f-]+\.md$/);
    expect(
      path.split("/").some((part) => part === "." || part === ".." || part.includes("\\")),
    ).toBe(false);
    expect(path).toMatch(new RegExp(COMPILED_NOTE_UUID_PATH_SQL_RE));
  });

  test("recognizes exact source, UUID path, and marker/Sources shape across newline styles", () => {
    const sources = `## Sources\n- ${PERSON_A}\n- ${PERSON_A.toUpperCase()}\n- not-a-uuid\n- ${PERSON_B}`;
    const body = `${COMPILED_NOTE_MARKER}\n\nsummary\n\n${sources}`;
    for (const variant of [body, body.replaceAll("\n", "\r\n"), body.replaceAll("\n", "\r")]) {
      const recognized = recognizeCompiledNote({ path: "notes/imported.md", bodyMd: variant });
      expect(recognized).toEqual({
        recognized: true,
        reason: "system_shape",
        pathIdentity: null,
        sourceIds: [PERSON_A, PERSON_B],
      });
      expect(hasCompiledOwnershipEvidence({ path: "notes/imported.md", bodyMd: variant })).toBe(
        true,
      );
      expect(parseCompiledNoteSourceIds(variant)).toEqual({
        hasSourcesHeading: true,
        ids: [PERSON_A, PERSON_B],
      });
    }
    expect(
      recognizeCompiledNote({
        path: "notes/imported.md",
        source: COMPILED_NOTE_SOURCE,
        bodyMd: "ordinary body",
      }),
    ).toEqual({ recognized: true, reason: "source", pathIdentity: null, sourceIds: [] });
    expect(
      recognizeCompiledNote({
        path: `derived/notes/person/name--${PERSON_A}.md`,
        bodyMd: "ordinary body",
      }),
    ).toEqual({
      recognized: true,
      reason: "uuid_path",
      pathIdentity: { kind: "person", entityId: PERSON_A },
      sourceIds: [],
    });
    expect(
      hasCompiledOwnershipEvidence({
        path: `derived/notes/person/name--${PERSON_A}.md`,
        bodyMd: "ordinary body",
      }),
    ).toBe(false);
  });

  test("rejects lookalike marker and headings", () => {
    const markerLookalike = `${COMPILED_NOTE_MARKER} extra\n\n## Sources\n- ${PERSON_A}`;
    const headingLookalike = `${COMPILED_NOTE_MARKER}\n\n### Sources\n- ${PERSON_A}`;
    const bulletLookalike = `${COMPILED_NOTE_MARKER}\n\n## Sources\n* ${PERSON_A}`;
    for (const bodyMd of [markerLookalike, headingLookalike, bulletLookalike]) {
      expect(recognizeCompiledNote({ path: "notes/imported.md", bodyMd })).toEqual({
        recognized: false,
      });
      expect(hasCompiledOwnershipEvidence({ path: "notes/imported.md", bodyMd })).toBe(false);
    }
  });

  test("requires marker and Sources at the beginning of a line", () => {
    const before = `prefix ${COMPILED_NOTE_MARKER}\n\n## Sources\n- ${PERSON_A}`;
    const indented = ` ${COMPILED_NOTE_MARKER}\n\n## Sources\n- ${PERSON_A}`;
    expect(recognizeCompiledNote({ path: "notes/imported.md", bodyMd: before })).toEqual({
      recognized: false,
    });
    expect(recognizeCompiledNote({ path: "notes/imported.md", bodyMd: indented })).toEqual({
      recognized: false,
    });
  });

  test("parses only canonical UUID bullets below the final Sources heading", () => {
    const body = [
      "## Sources",
      `- ${PERSON_A}`,
      "ignored text",
      "## Sources",
      `- ${PERSON_B.toUpperCase()}`,
      `- ${PERSON_B}`,
      `-  ${PERSON_A}`,
      "- 11111111-2222-3333-4444-55555555555z",
    ].join("\n");
    expect(parseCompiledNoteSourceIds(body)).toEqual({ hasSourcesHeading: true, ids: [PERSON_B] });
  });

  test("parses canonical archive only at tier 1 or 2 and rejects malformed frontmatter", () => {
    const rendered = renderCompiledNoteArchive({ title: "Title", tier: 1, bodyMd: "body" });
    expect(parseCompiledNoteArchive(rendered.text)).toEqual(rendered);
    expect(parseCompiledNoteArchive(rendered.text.replace("tier: 1", "tier: 3"))).toBeNull();
    expect(parseCompiledNoteArchive("body")).toBeNull();
    expect(parseCompiledNoteArchive("---\ntitle: title\ntier: 1\n---\nbody\n\n")).toBeNull();
  });

  test("frontmatter keeps safe single-quoted tier scalars and a closing delimiter at EOF compatible", () => {
    expect(parseFrontmatterDocument("---\ntitle: Legacy\ntier: '2'\n---\nbody\n")).toEqual({
      title: "Legacy",
      tier: 2,
      body: "body\n",
    });
    expect(parseFrontmatterDocument("---\ntitle: EOF\ntier: 2\n---")).toEqual({
      title: "EOF",
      tier: 2,
      body: "",
    });
  });

  test("uses an opaque 16-character lowercase SHA-256 target hash", () => {
    const target = "/private/path/title-with-sensitive-data.md";
    expect(opaqueTargetHash(target)).toBe(
      createHash("sha256").update(target).digest("hex").slice(0, 16),
    );
    expect(opaqueTargetHash(target)).toMatch(/^[0-9a-f]{16}$/);
  });

  test("keeps archive target lexically contained under the brain root", () => {
    const brain = "/private/data/brain";
    expect(resolveCompiledNoteArchiveTarget(brain, "derived/notes/a.md")).toBe(
      resolve(brain, "derived/notes/a.md"),
    );
    expect(resolveCompiledNoteArchiveTarget(brain, "../outside.md")).toBeNull();
    expect(resolveCompiledNoteArchiveTarget(brain, "/tmp/outside.md")).toBeNull();
    expect(resolveCompiledNoteArchiveTarget(brain, brain)).toBeNull();
    expect(resolveCompiledNoteArchiveTarget(brain, "")).toBeNull();
  });
});

describe("private archive roots and atomic writes", () => {
  test("rejects broad data roots before changing their modes", async () => {
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
      REPO_ROOT,
    ].filter(existsSync);
    const broadRoots = new Set([
      ...broadSpellings,
      ...broadSpellings.map((path) => realpathSync(path)),
    ]);
    for (const candidate of broadRoots) {
      expect(() => assertDedicatedPrivateDataRoot(candidate)).toThrow(UNSAFE_PRIVATE_ROOT);
    }
  });

  test("rejects an intermediate-symlink data root without mutating its target", () =>
    withPrivateDataDir(async (root) => {
      const outside = await mkdtemp(join(PRIVATE_TMP, "minime-data-parent-outside-"));
      privateRoots.push(outside);
      await chmod(outside, 0o755);
      const link = join(root, "linked-parent");
      await symlink(outside, link);
      const beforeMode = (await lstat(outside)).mode & 0o777;
      const beforeEntries = await readdir(outside);

      await expect(ensurePrivateDataRoot(join(link, "nested-data"))).rejects.toThrow(
        UNSAFE_PRIVATE_ROOT,
      );
      expect((await lstat(outside)).mode & 0o777).toBe(beforeMode);
      expect(await readdir(outside)).toEqual(beforeEntries);
    }));

  test("creates an absent data root privately and rejects a symlinked data root", () =>
    withPrivateDataDir(async (root) => {
      const original = config.dataDir;
      const freshRoot = join(root, "fresh-data");
      config.dataDir = freshRoot;
      await atomicWritePrivate(join(freshRoot, "inbox", "capture.md"), "private bytes");
      expect((await lstat(freshRoot)).mode & 0o777).toBe(0o700);
      expect((await lstat(join(freshRoot, "inbox"))).mode & 0o777).toBe(0o700);
      expect((await lstat(join(freshRoot, "inbox", "capture.md"))).mode & 0o777).toBe(0o600);

      const outside = await mkdtemp(join(PRIVATE_TMP, "minime-private-root-outside-"));
      privateRoots.push(outside);
      await chmod(outside, 0o755);
      const linkedRoot = join(root, "linked-data");
      await symlink(outside, linkedRoot);
      config.dataDir = linkedRoot;
      await expect(
        atomicWritePrivate(join(linkedRoot, "inbox", "capture.md"), "must not escape"),
      ).rejects.toThrow(UNSAFE_PRIVATE_ROOT);
      expect((await lstat(outside)).mode & 0o777).toBe(0o755);
      expect(await readdir(outside)).toEqual([]);
      config.dataDir = original;
      await rm(outside, { recursive: true, force: true });
      privateRoots = privateRoots.filter((candidate) => candidate !== outside);
    }));

  test("normalizes the data root and every owned directory before a private write", () =>
    withPrivateDataDir(async (root) => {
      const brain = join(root, "brain");
      const derived = join(brain, "derived");
      const notes = join(derived, "notes");
      await mkdir(notes, { recursive: true, mode: 0o755 });
      for (const path of [root, brain, derived, notes]) await chmod(path, 0o755);

      const target = join(notes, "private.md");
      await atomicWritePrivate(target, "private bytes");

      for (const path of [root, brain, derived, notes]) {
        expect((await lstat(path)).mode & 0o777).toBe(0o700);
      }
      expect((await lstat(target)).mode & 0o777).toBe(0o600);
    }));

  test("preflights a private root without chmod or traversal of a symlink", () =>
    withPrivateDataDir(async (root) => {
      const outside = await mkdtemp(join(PRIVATE_TMP, "minime-h1-note-outside-"));
      privateRoots.push(outside);
      await chmod(outside, 0o700);
      const sentinel = join(outside, "sentinel.txt");
      await writeBytes(sentinel, "unchanged");
      const beforeMode = (await lstat(outside)).mode & 0o777;
      const beforeEntries = await readdir(outside);
      const brain = join(root, "brain");
      await symlink(outside, brain);
      await expect(preflightPrivateRoot(root, brain, { create: true })).rejects.toThrow();
      await expect(assertNoSymlinkComponents(root, join(brain, "note.md"))).rejects.toThrow();
      expect((await lstat(outside)).mode & 0o777).toBe(beforeMode);
      expect(await readdir(outside)).toEqual(beforeEntries);
      expect(await readFile(sentinel, "utf8")).toBe("unchanged");
      await rm(outside, { recursive: true, force: true });
      privateRoots = privateRoots.filter((candidate) => candidate !== outside);
    }));

  test.each(["brain", "tmp", "tmp/compiled-notes"])(
    "rejects a symlinked private root before injected filesystem operations: %s",
    (relativeRoot) =>
      withPrivateDataDir(async (root) => {
        const outside = await mkdtemp(join(PRIVATE_TMP, "minime-h1-note-symlink-"));
        privateRoots.push(outside);
        await chmod(outside, 0o700);
        const sentinel = join(outside, "sentinel.txt");
        await writeBytes(sentinel, "unchanged");
        const beforeMode = (await lstat(outside)).mode & 0o777;
        const beforeEntries = await readdir(outside);
        const targetRoot = join(root, relativeRoot);
        await mkdir(dirname(targetRoot), { recursive: true, mode: 0o700 });
        await symlink(outside, targetRoot);
        await expect(preflightPrivateRoot(root, targetRoot, { create: true })).rejects.toThrow();
        expect((await lstat(outside)).mode & 0o777).toBe(beforeMode);
        expect(await readdir(outside)).toEqual(beforeEntries);
        expect(await readFile(sentinel, "utf8")).toBe("unchanged");
        await rm(outside, { recursive: true, force: true });
        privateRoots = privateRoots.filter((candidate) => candidate !== outside);
      }),
  );

  test("rejects final and intermediate symlinks and realpath escapes", async () => {
    await withPrivateDataDir(async (root) => {
      const brain = join(root, "brain");
      await mkdir(join(brain, "derived", "notes"), { recursive: true, mode: 0o700 });
      const outside = await mkdtemp(join(PRIVATE_TMP, "minime-h1-note-realpath-"));
      privateRoots.push(outside);
      await chmod(outside, 0o700);
      await symlink(outside, join(brain, "derived", "escape"));
      await expect(
        assertNoSymlinkComponents(root, join(brain, "derived", "escape", "x.md")),
      ).rejects.toThrow();
      await symlink(join(brain, "derived", "notes"), join(brain, "derived", "final-link"));
      await expect(
        assertNoSymlinkComponents(root, join(brain, "derived", "final-link")),
      ).rejects.toThrow();
      await rm(outside, { recursive: true, force: true });
      privateRoots = privateRoots.filter((candidate) => candidate !== outside);
    });
  });

  test("creates mode-0700 parents, mode-0600 final files, and removes only its own temp", async () => {
    await withPrivateDataDir(async (root) => {
      const target = join(root, "brain", "derived", "notes", "note.md");
      await mkdir(dirname(target), { recursive: true, mode: 0o755 });
      await chmod(dirname(target), 0o755);
      await writeBytes(target, "old");
      const sibling = join(dirname(target), "unrelated.tmp");
      await writeBytes(sibling, "keep");
      await createAtomicFileWriter(makeCountingOps())(target, "new");
      expect(await readFile(target, "utf8")).toBe("new");
      expect((await lstat(dirname(target))).mode & 0o777).toBe(0o700);
      expect((await lstat(target)).mode & 0o777).toBe(0o600);
      expect(await readFile(sibling, "utf8")).toBe("keep");
      expect((await readdir(dirname(target))).filter((name) => name.endsWith(".tmp"))).toEqual([
        "unrelated.tmp",
      ]);
    });
  });

  test.each(["write", "file-sync", "close", "rename"])(
    "preserves prior target and cleans own temp on %s failure",
    async (failure) => {
      await withPrivateDataDir(async (root) => {
        const target = join(root, "brain", "note.md");
        await mkdir(dirname(target), { recursive: true, mode: 0o700 });
        await writeBytes(target, "old");
        const counters = {
          mkdir: 0,
          chmod: 0,
          open: 0,
          write: 0,
          sync: 0,
          close: 0,
          rename: 0,
          unlink: 0,
        };
        const ops = makeCountingOps(counters, failure);
        await expect(createAtomicFileWriter(ops)(target, "new")).rejects.toThrow();
        expect(await readFile(target, "utf8")).toBe("old");
        expect(
          (await readdir(dirname(target))).filter(
            (name) => name.includes(`${process.pid}.`) && name.endsWith(".tmp"),
          ),
        ).toEqual([]);
        expect(counters.close).toBeGreaterThan(0);
      });
    },
  );

  test("leaves a complete target after parent directory sync failure", async () => {
    await withPrivateDataDir(async (root) => {
      const target = join(root, "brain", "note.md");
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await writeBytes(target, "old");
      const ops = makeCountingOps(
        { mkdir: 0, chmod: 0, open: 0, write: 0, sync: 0, close: 0, rename: 0, unlink: 0 },
        "parent-sync",
      );
      await expect(createAtomicFileWriter(ops)(target, "new")).rejects.toThrow();
      expect(await readFile(target, "utf8")).toBe("new");
      expect((await readdir(dirname(target))).some((name) => name.endsWith(".tmp"))).toBe(false);
    });
  });

  test("closes handles when close itself reports a failure", async () => {
    await withPrivateDataDir(async (root) => {
      const target = join(root, "brain", "note.md");
      const counters = {
        mkdir: 0,
        chmod: 0,
        open: 0,
        write: 0,
        sync: 0,
        close: 0,
        rename: 0,
        unlink: 0,
      };
      await expect(
        createAtomicFileWriter(makeCountingOps(counters, "close"))(target, "new"),
      ).rejects.toThrow();
      expect(counters.open).toBeGreaterThan(0);
      expect(counters.close).toBeGreaterThanOrEqual(counters.open);
    });
  });

  test("preserves an unowned temp sibling when exclusive temp open reports EEXIST", async () => {
    await withPrivateDataDir(async (root) => {
      const target = join(root, "brain", "note.md");
      const counters = {
        mkdir: 0,
        chmod: 0,
        open: 0,
        write: 0,
        sync: 0,
        close: 0,
        rename: 0,
        unlink: 0,
      };
      const baseOps = makeCountingOps(counters);
      let tempPath = "";
      const ops: AtomicFileOps = {
        ...baseOps,
        open: async (path, flags, mode) => {
          if (flags === "wx") {
            tempPath = path;
            await writeBytes(path, "unowned");
            const error = Object.assign(new Error("exclusive collision"), { code: "EEXIST" });
            throw error;
          }
          return baseOps.open(path, flags, mode);
        },
      };
      await expect(createAtomicFileWriter(ops)(target, "new")).rejects.toMatchObject({
        code: "EEXIST",
      });
      expect(await readFile(tempPath, "utf8")).toBe("unowned");
      expect(counters.unlink).toBe(0);
    });
  });

  test("preserves an unrelated replacement recreated after successful rename", async () => {
    await withPrivateDataDir(async (root) => {
      const target = join(root, "brain", "note.md");
      const counters = {
        mkdir: 0,
        chmod: 0,
        open: 0,
        write: 0,
        sync: 0,
        close: 0,
        rename: 0,
        unlink: 0,
      };
      const baseOps = makeCountingOps(counters);
      let formerTempPath = "";
      const ops: AtomicFileOps = {
        ...baseOps,
        rename: async (from, to) => {
          await baseOps.rename(from, to);
          formerTempPath = from;
          await writeBytes(from, "unrelated replacement");
        },
      };
      await createAtomicFileWriter(ops)(target, "new");
      expect(await readFile(target, "utf8")).toBe("new");
      expect(await readFile(formerTempPath, "utf8")).toBe("unrelated replacement");
    });
  });

  test("surfaces owned-temp cleanup failure together with the primary write failure", async () => {
    await withPrivateDataDir(async (root) => {
      const target = join(root, "brain", "note.md");
      const counters = {
        mkdir: 0,
        chmod: 0,
        open: 0,
        write: 0,
        sync: 0,
        close: 0,
        rename: 0,
        unlink: 0,
      };
      const baseOps = makeCountingOps(counters, "write");
      let tempPath = "";
      const ops: AtomicFileOps = {
        ...baseOps,
        open: async (path, flags, mode) => {
          if (flags === "wx") tempPath = path;
          return baseOps.open(path, flags, mode);
        },
        unlink: async (path) => {
          if (path === tempPath) {
            const error = Object.assign(new Error("cleanup denied"), { code: "EACCES" });
            throw error;
          }
          return baseOps.unlink(path);
        },
      };
      const rejection = await createAtomicFileWriter(ops)(target, "new").catch((error) => error);
      expect(rejection).toBeInstanceOf(AggregateError);
      const errors = (rejection as AggregateError).errors;
      expect(errors).toHaveLength(2);
      expect(errors[0]).toMatchObject({ message: "injected write failure" });
      expect(errors[1]).toMatchObject({ message: "cleanup denied", code: "EACCES" });
    });
  });
});

async function writeBytes(path: string, data: string): Promise<void> {
  const handle = await fsOpen(path, "w", 0o600);
  try {
    await handle.writeFile(data);
  } finally {
    await handle.close();
  }
}

type FailureStage = "write" | "file-sync" | "close" | "rename" | "parent-sync";
type Counters = {
  mkdir: number;
  chmod: number;
  open: number;
  write: number;
  sync: number;
  close: number;
  rename: number;
  unlink: number;
};

function makeCountingOps(
  counters: Counters = {
    mkdir: 0,
    chmod: 0,
    open: 0,
    write: 0,
    sync: 0,
    close: 0,
    rename: 0,
    unlink: 0,
  },
  failure?: FailureStage,
): AtomicFileOps {
  let fileSyncs = 0;
  let closeFailures = 0;
  let parentSyncs = 0;
  return {
    mkdir: async (path, options) => {
      counters.mkdir++;
      await mkdir(path, options);
    },
    chmod: async (path, mode) => {
      counters.chmod++;
      await chmod(path, mode);
    },
    open: async (path, flags, mode) => {
      counters.open++;
      const handle = await fsOpen(path, flags, mode);
      const directory = flags === "r";
      let closed = false;
      return {
        writeFile: async (data) => {
          counters.write++;
          if (failure === "write") throw new Error("injected write failure");
          await handle.writeFile(data);
        },
        sync: async () => {
          counters.sync++;
          if (!directory) {
            fileSyncs++;
            if (failure === "file-sync" && fileSyncs === 1)
              throw new Error("injected file sync failure");
          } else {
            parentSyncs++;
            if (failure === "parent-sync" && parentSyncs === 1)
              throw new Error("injected parent sync failure");
          }
          await handle.sync();
        },
        close: async () => {
          counters.close++;
          if (failure === "close" && closeFailures++ === 0) {
            await handle.close();
            throw new Error("injected close failure");
          }
          if (!closed) {
            closed = true;
            await handle.close();
          }
        },
      };
    },
    rename: async (from, to) => {
      counters.rename++;
      if (failure === "rename") throw new Error("injected rename failure");
      await rename(from, to);
    },
    unlink: async (path) => {
      counters.unlink++;
      await unlink(path);
    },
  };
}
