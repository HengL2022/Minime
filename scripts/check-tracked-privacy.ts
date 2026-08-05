import { lstatSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

type ErrorCode =
  | "usage"
  | "non_repo"
  | "invalid_base"
  | "non_ancestor"
  | "malformed_terms"
  | "git"
  | "io";

type Match = {
  scope: "tree" | "outgoing_blob" | "commit";
  path?: string;
  oid?: string;
  line: number;
  occurrences: number;
};

class PrivacyError extends Error {
  constructor(
    readonly code: ErrorCode,
    readonly exitCode: 2 | 3,
  ) {
    super(code);
  }
}

class GitError extends Error {
  constructor(readonly exitCode: number) {
    super(`git exited ${exitCode}`);
  }
}

const decoder = new TextDecoder("utf-8", { fatal: true });
const permissiveDecoder = new TextDecoder("utf-8");

function gitFailure(error: unknown): never {
  if (error instanceof PrivacyError) throw error;
  throw new PrivacyError("git", 3);
}

function usage(): never {
  throw new PrivacyError("usage", 2);
}

function gitEnvironment(): Record<string, string> {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    LANG: "C",
    LC_ALL: "C",
    HOME: "/nonexistent",
  };
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_CONFIG_SYSTEM = "/dev/null";
  env.GIT_CONFIG_GLOBAL = "/dev/null";
  env.GIT_PAGER = "cat";
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_TRACE = "0";
  env.GIT_TRACE2 = "0";
  env.GIT_TRACE2_EVENT = "0";
  return env;
}

function gitArgv(args: string[]): string[] {
  return ["git", "-c", "core.fsmonitor=false", ...args];
}

function runGit(cwd: string, args: string[]): Uint8Array {
  try {
    const result = Bun.spawnSync(gitArgv(args), {
      cwd,
      env: gitEnvironment(),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    });
    if (result.exitCode !== 0) throw new GitError(result.exitCode ?? 3);
    return result.stdout;
  } catch (error) {
    if (error instanceof GitError) throw error;
    throw new PrivacyError("io", 3);
  }
}

function runGitStatus(cwd: string, args: string[]): number {
  try {
    const result = Bun.spawnSync(gitArgv(args), {
      cwd,
      env: gitEnvironment(),
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    return result.exitCode ?? 3;
  } catch {
    throw new PrivacyError("io", 3);
  }
}

function permissiveText(bytes: Uint8Array): string {
  return permissiveDecoder.decode(bytes);
}

function parseArgs(args: string[]): { base: string; termsFd: number } {
  let base: string | undefined;
  let termsFd = 0;
  let termsFdSet = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--base") {
      if (base !== undefined || index + 1 >= args.length || args[index + 1]!.startsWith("--")) {
        usage();
      }
      base = args[++index]!;
      continue;
    }
    if (arg === "--terms-fd") {
      if (termsFdSet) usage();
      if (index + 1 >= args.length || !/^\d+$/.test(args[index + 1]!)) usage();
      const parsed = Number(args[++index]);
      if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 2_147_483_647) usage();
      termsFd = parsed;
      termsFdSet = true;
      continue;
    }
    usage();
  }
  if (base === undefined || base.length === 0) usage();
  return { base, termsFd };
}

function readTerms(fd: number): string[] {
  let bytes: Uint8Array;
  try {
    bytes = readFileSync(fd);
  } catch {
    throw new PrivacyError("malformed_terms", 2);
  }
  if (bytes.includes(0)) throw new PrivacyError("malformed_terms", 2);
  let source: string;
  try {
    source = decoder.decode(bytes);
  } catch {
    throw new PrivacyError("malformed_terms", 2);
  }
  const lines = source.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const terms = new Set<string>();
  for (const original of lines) {
    const term = original.endsWith("\r") ? original.slice(0, -1) : original;
    if (term.length === 0) throw new PrivacyError("malformed_terms", 2);
    terms.add(term);
  }
  if (terms.size === 0) throw new PrivacyError("malformed_terms", 2);
  return [...terms];
}

function parseNul(bytes: Uint8Array): Uint8Array[] {
  const records: Uint8Array[] = [];
  let start = 0;
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] !== 0) continue;
    records.push(bytes.slice(start, index));
    start = index + 1;
  }
  if (start < bytes.length) records.push(bytes.slice(start));
  return records;
}

function parseOidRecords(bytes: Uint8Array): Set<string> {
  const objects = new Set<string>();
  for (const record of parseNul(bytes)) {
    const oid = permissiveText(record);
    if (/^[0-9a-f]{40,64}$/.test(oid)) objects.add(oid);
  }
  return objects;
}

function safeRelativePath(root: string, value: string): string | undefined {
  if (value.length === 0 || value.includes("\0") || isAbsolute(value)) return undefined;
  const absolute = resolve(root, value);
  const prefix = root.endsWith(sep) ? root : root + sep;
  if (absolute !== root && !absolute.startsWith(prefix)) return undefined;
  return relative(root, absolute).split(sep).join("/");
}

function countOccurrences(line: string, term: string): number {
  let count = 0;
  let from = 0;
  while (from <= line.length - term.length) {
    const at = line.indexOf(term, from);
    if (at < 0) break;
    count += 1;
    from = at + Math.max(term.length, 1);
  }
  return count;
}

function findMatches(bytes: Uint8Array, terms: string[]): Map<number, number> | undefined {
  if (bytes.includes(0)) return undefined;
  let source: string;
  try {
    source = decoder.decode(bytes);
  } catch {
    return undefined;
  }
  const matches = new Map<number, number>();
  for (const [index, line] of source.split("\n").entries()) {
    let occurrences = 0;
    for (const term of terms) occurrences += countOccurrences(line, term);
    if (occurrences > 0) matches.set(index + 1, occurrences);
  }
  return matches;
}

function treeBytes(root: string, path: string): Uint8Array | undefined {
  const parts = path.split("/");
  let parent = root;
  try {
    for (const component of parts.slice(0, -1)) {
      parent = join(parent, component);
      const parentStat = lstatSync(parent);
      if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) return undefined;
    }
    const absolute = join(parent, parts.at(-1)!);
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink()) return new TextEncoder().encode(readlinkSync(absolute));
    if (stat.isFile()) return readFileSync(absolute);
    return undefined;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return undefined;
    throw new PrivacyError("io", 3);
  }
}

function indexBlobIds(root: string): Map<string, string[]> {
  let bytes: Uint8Array;
  try {
    bytes = runGit(root, ["ls-files", "-s", "-z"]);
  } catch (error) {
    gitFailure(error);
  }
  const ids = new Map<string, string[]>();
  for (const record of parseNul(bytes)) {
    const tab = record.indexOf(9);
    if (tab < 0) throw new PrivacyError("git", 3);
    const metadata = permissiveText(record.slice(0, tab)).split(/\s+/);
    const mode = metadata[0];
    const oid = metadata[1];
    if (mode !== "100644" && mode !== "100755" && mode !== "120000") continue;
    if (!oid || !/^[0-9a-f]{40,64}$/.test(oid)) throw new PrivacyError("git", 3);
    const path = safeRelativePath(root, permissiveText(record.slice(tab + 1)));
    if (path === undefined) continue;
    const existing = ids.get(path) ?? [];
    if (!existing.includes(oid)) existing.push(oid);
    ids.set(path, existing);
  }
  return ids;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function redactionToken(terms: string[]): string {
  const safe = (candidate: string): boolean =>
    terms.every((term) => !candidate.includes(term) && !term.includes(candidate));
  if (safe("[redacted]")) return "[redacted]";
  for (let codePoint = 0xe000; codePoint <= 0xf8ff; codePoint += 1) {
    const candidate = String.fromCodePoint(codePoint);
    if (safe(candidate)) return candidate;
  }
  for (let codePoint = 0x100000; codePoint <= 0x10ffff; codePoint += 1) {
    const candidate = String.fromCodePoint(codePoint);
    if (safe(candidate)) return candidate;
  }
  return "[redacted]";
}

function redactPath(path: string, terms: string[]): string {
  const token = redactionToken(terms);
  const ordered = [...terms].sort((left, right) => right.length - left.length);
  let redacted = path;
  for (const term of ordered) redacted = redacted.split(term).join(token);
  return redacted;
}

function indexBytes(root: string, oid: string): Uint8Array {
  return objectBytes(root, "blob", oid);
}

function scanTree(root: string, terms: string[], matches: Match[]): number {
  let paths: Uint8Array;
  try {
    paths = runGit(root, ["ls-files", "-z"]);
  } catch (error) {
    gitFailure(error);
  }
  const index = indexBlobIds(root);
  let files = 0;
  for (const rawPath of parseNul(paths)) {
    const path = safeRelativePath(root, permissiveText(rawPath));
    if (!path) throw new PrivacyError("io", 3);
    const workingBytes = treeBytes(root, path);
    const indexOids = index.get(path) ?? [];
    const stagedBytes = indexOids.map((oid) => indexBytes(root, oid));
    if (!workingBytes && stagedBytes.length === 0) continue;
    files += 1;
    const sources: Array<Uint8Array | undefined> = [workingBytes];
    for (const staged of stagedBytes) {
      if (!workingBytes || !sameBytes(workingBytes, staged)) sources.push(staged);
    }
    for (const bytes of sources) {
      if (!bytes) continue;
      const found = findMatches(bytes, terms);
      if (!found) continue;
      for (const [line, occurrences] of found) {
        matches.push({ scope: "tree", path, line, occurrences });
      }
    }
  }
  return files;
}

function outgoingObjectPaths(
  root: string,
  base: string,
  baseObjects: Set<string>,
): Map<string, string> {
  let bytes: Uint8Array;
  try {
    bytes = runGit(root, ["rev-list", "--objects", "-z", `${base}..HEAD`]);
  } catch (error) {
    gitFailure(error);
  }
  const paths = new Map<string, string>();
  let pending: string | undefined;
  for (const record of parseNul(bytes)) {
    const value = permissiveText(record);
    if (/^[0-9a-f]{40,64}$/.test(value)) {
      pending = value;
      if (baseObjects.has(value)) pending = undefined;
      continue;
    }
    if (pending && value.startsWith("path=")) {
      const path = safeRelativePath(root, value.slice(5));
      if (path !== undefined && !paths.has(pending)) paths.set(pending, path);
      pending = undefined;
    }
  }
  return paths;
}

function objectType(root: string, oid: string): string {
  try {
    const result = permissiveText(runGit(root, ["cat-file", "-t", "--", oid])).trim();
    return result;
  } catch (error) {
    gitFailure(error);
  }
}

function objectBytes(root: string, type: string, oid: string): Uint8Array {
  try {
    return runGit(root, ["cat-file", type, "--", oid]);
  } catch (error) {
    gitFailure(error);
  }
}

function scanOutgoingBlobs(root: string, base: string, terms: string[], matches: Match[]): number {
  let baseBytes: Uint8Array;
  try {
    baseBytes = runGit(root, ["rev-list", "--objects", "-z", "--no-object-names", base]);
  } catch (error) {
    gitFailure(error);
  }
  const baseObjects = parseOidRecords(baseBytes);
  const paths = outgoingObjectPaths(root, base, baseObjects);
  let blobs = 0;
  for (const [oid, path] of paths) {
    if (objectType(root, oid) !== "blob") continue;
    blobs += 1;
    const found = findMatches(objectBytes(root, "blob", oid), terms);
    if (!found) continue;
    for (const [line, occurrences] of found) {
      matches.push({ scope: "outgoing_blob", oid, path, line, occurrences });
    }
  }
  return blobs;
}

function scanCommit(root: string, oid: string, terms: string[], matches: Match[]): void {
  const bytes = objectBytes(root, "commit", oid);
  let separator = -1;
  for (let index = 0; index + 1 < bytes.length; index += 1) {
    if (bytes[index] === 0x0a && bytes[index + 1] === 0x0a) {
      separator = index;
      break;
    }
  }
  const headerBytes = separator < 0 ? bytes : bytes.slice(0, separator);
  let headers: string;
  try {
    headers = decoder.decode(headerBytes);
  } catch {
    return;
  }
  let signature = false;
  const headerLines = headers.split("\n");
  for (let index = 0; index < headerLines.length; index += 1) {
    const line = headerLines[index]!;
    if (signature && line.startsWith(" ")) {
      const occurrences = terms.reduce((total, term) => total + countOccurrences(line, term), 0);
      if (occurrences > 0) matches.push({ scope: "commit", oid, line: index + 1, occurrences });
      continue;
    }
    const separatorIndex = line.indexOf(" ");
    const key = (separatorIndex < 0 ? line : line.slice(0, separatorIndex)).toLowerCase();
    const occurrences = terms.reduce((total, term) => total + countOccurrences(line, term), 0);
    if (occurrences > 0) matches.push({ scope: "commit", oid, line: index + 1, occurrences });
    signature = key.includes("sig");
  }
  if (separator < 0) return;
  const bodyBytes = bytes.slice(separator + 2);
  if (bodyBytes.includes(0)) return;
  let body: string;
  try {
    body = decoder.decode(bodyBytes);
  } catch {
    return;
  }
  for (const [index, line] of body.split("\n").entries()) {
    const occurrences = terms.reduce((total, term) => total + countOccurrences(line, term), 0);
    if (occurrences > 0) {
      matches.push({ scope: "commit", oid, line: headerLines.length + index + 2, occurrences });
    }
  }
}

function scanCommits(root: string, base: string, terms: string[], matches: Match[]): number {
  let source: string;
  try {
    source = permissiveText(runGit(root, ["rev-list", "--reverse", `${base}..HEAD`]));
  } catch (error) {
    gitFailure(error);
  }
  const commits = source.split(/\s+/).filter((oid) => /^[0-9a-f]{40,64}$/.test(oid));
  for (const oid of commits) {
    if (objectType(root, oid) !== "commit") throw new PrivacyError("git", 3);
    scanCommit(root, oid, terms, matches);
  }
  return commits.length;
}

function printMatch(match: Match, terms: string[]): string {
  if (match.scope === "tree") {
    return `PRIVACY_SCAN match scope=tree path=${JSON.stringify(redactPath(match.path!, terms))} line=${match.line} occurrences=${match.occurrences}`;
  }
  if (match.scope === "outgoing_blob") {
    return `PRIVACY_SCAN match scope=outgoing_blob oid=${match.oid} path=${JSON.stringify(redactPath(match.path!, terms))} line=${match.line} occurrences=${match.occurrences}`;
  }
  return `PRIVACY_SCAN match scope=commit oid=${match.oid} line=${match.line} occurrences=${match.occurrences}`;
}

function hasGitMarker(cwd: string): boolean {
  let current = resolve(cwd);
  for (;;) {
    try {
      lstatSync(join(current, ".git"));
      return true;
    } catch {
      const parent = resolve(current, "..");
      if (parent === current) return false;
      current = parent;
    }
  }
}

function repositoryRoot(cwd: string): string {
  try {
    const inside = permissiveText(runGit(cwd, ["rev-parse", "--is-inside-work-tree"])).trim();
    if (inside !== "true") {
      const marker = hasGitMarker(cwd);
      throw new PrivacyError(marker ? "git" : "non_repo", marker ? 3 : 2);
    }
    const rootText = permissiveText(runGit(cwd, ["rev-parse", "--show-toplevel"])).trim();
    const root = realpathSync(rootText);
    const bare = permissiveText(runGit(root, ["rev-parse", "--is-bare-repository"])).trim();
    if (bare !== "false") throw new PrivacyError("git", 3);
    return root;
  } catch (error) {
    if (error instanceof PrivacyError) throw error;
    if (error instanceof GitError) {
      const marker = hasGitMarker(cwd);
      throw new PrivacyError(marker ? "git" : "non_repo", marker ? 3 : 2);
    }
    throw new PrivacyError("io", 3);
  }
}

function validateBase(root: string, base: string): string {
  const resolveCommit = (ref: string): string => {
    try {
      const oid = permissiveText(
        runGit(root, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`]),
      ).trim();
      if (!/^[0-9a-f]{40,64}$/.test(oid)) throw new GitError(3);
      return oid;
    } catch (error) {
      if (error instanceof PrivacyError) throw error;
      if (error instanceof GitError) throw error;
      throw new GitError(3);
    }
  };
  let headOid: string;
  try {
    headOid = resolveCommit("HEAD");
  } catch {
    throw new PrivacyError("git", 3);
  }
  let baseOid: string;
  try {
    baseOid = resolveCommit(base);
  } catch (error) {
    if (error instanceof PrivacyError) throw error;
    if (error instanceof GitError && error.exitCode === 1) {
      throw new PrivacyError("invalid_base", 2);
    }
    throw new PrivacyError("git", 3);
  }
  const ancestry = runGitStatus(root, ["merge-base", "--is-ancestor", baseOid, headOid]);
  if (ancestry === 1) throw new PrivacyError("non_ancestor", 2);
  if (ancestry !== 0) throw new PrivacyError("git", 3);
  return baseOid;
}

function main(): void {
  const { base: requestedBase, termsFd } = parseArgs(Bun.argv.slice(2));
  const terms = readTerms(termsFd);
  const root = repositoryRoot(process.cwd());
  const base = validateBase(root, requestedBase);
  const matches: Match[] = [];
  const treeFiles = scanTree(root, terms, matches);
  const outgoingBlobs = scanOutgoingBlobs(root, base, terms, matches);
  const outgoingCommits = scanCommits(root, base, terms, matches);
  for (const match of matches) process.stdout.write(`${printMatch(match, terms)}\n`);
  const status = matches.length === 0 ? "clear" : "hits";
  process.stdout.write(
    `PRIVACY_SCAN summary status=${status} tree_files=${treeFiles} outgoing_blobs=${outgoingBlobs} outgoing_commits=${outgoingCommits} matches=${matches.length}\n`,
  );
  process.exitCode = matches.length === 0 ? 0 : 1;
}

try {
  main();
} catch (error) {
  if (error instanceof PrivacyError) {
    process.stdout.write(`PRIVACY_SCAN error code=${error.code}\n`);
    process.exitCode = error.exitCode;
  } else if (error instanceof GitError) {
    process.stdout.write("PRIVACY_SCAN error code=git\n");
    process.exitCode = 3;
  } else {
    process.stdout.write("PRIVACY_SCAN error code=io\n");
    process.exitCode = 3;
  }
}
