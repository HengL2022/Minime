import { lstatSync, realpathSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, relative, resolve } from "node:path";

export const UNSAFE_DATA_ROOT = "UNSAFE_PRIVATE_ROOT";

function equalOrAncestor(candidate: string, protectedPath: string): boolean {
  const rel = relative(resolve(candidate), resolve(protectedPath));
  return !rel || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith("../"));
}

function protectedAliases(path: string): string[] {
  const lexical = resolve(path);
  try {
    const physical = realpathSync(lexical);
    return physical === lexical ? [lexical] : [lexical, physical];
  } catch {
    return [lexical];
  }
}

function existingAncestors(path: string): string[] {
  const ancestors: string[] = [];
  let current = resolve(path);
  while (true) {
    try {
      statSync(current);
      ancestors.push(current);
    } catch {
      // Missing suffixes are allowed; continue to the first existing parent.
    }
    const parent = dirname(current);
    if (parent === current) return ancestors;
    current = parent;
  }
}

function filesystemIdentity(path: string): string | undefined {
  try {
    const info = statSync(path);
    return `${info.dev}:${info.ino}`;
  } catch {
    return undefined;
  }
}

function canonicalizeTrustedSystemAlias(path: string): string {
  const candidate = resolve(path);
  for (const alias of ["/tmp", "/var"]) {
    const aliasRoot = resolve(alias);
    const rel = relative(aliasRoot, candidate);
    if (isAbsolute(rel) || rel === ".." || rel.startsWith("../")) continue;
    try {
      const info = lstatSync(aliasRoot);
      if (!info.isSymbolicLink() || info.uid !== 0) continue;
      return resolve(realpathSync(aliasRoot), rel);
    } catch {
      // If the platform does not expose this root-owned compatibility alias, keep the lexical path.
    }
  }
  return candidate;
}

/**
 * Reject a configured root whose permission normalization or backup traversal could cover a
 * shared/system tree. Dedicated descendants (for example repo/data or ~/.minime/data) remain
 * valid; the shared root itself and any of its ancestors do not.
 */
export function assertDedicatedDataRoot(
  dataRoot: string,
  repoRoot: string,
  cwd = process.cwd(),
): string {
  const root = canonicalizeTrustedSystemAlias(dataRoot);
  const protectedRoots = ["/", "/tmp", "/var/tmp", homedir(), tmpdir(), repoRoot].flatMap(
    protectedAliases,
  );
  if (root !== resolve(repoRoot, "data")) protectedRoots.push(...protectedAliases(cwd));
  const candidateAliases = protectedAliases(root);
  const protectedIdentities = new Set(
    protectedRoots.flatMap(existingAncestors).map(filesystemIdentity).filter(Boolean),
  );
  if (
    candidateAliases.some((candidate) =>
      protectedRoots.some((protectedRoot) => equalOrAncestor(candidate, protectedRoot)),
    ) ||
    candidateAliases.some((candidate) => {
      const identity = filesystemIdentity(candidate);
      return identity !== undefined && protectedIdentities.has(identity);
    })
  ) {
    throw new Error(UNSAFE_DATA_ROOT);
  }
  return root;
}
