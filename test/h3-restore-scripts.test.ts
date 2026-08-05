import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";

const H3_SUBPROCESS_INTEGRATION_TIMEOUT_MS = 30_000;
setDefaultTimeout(H3_SUBPROCESS_INTEGRATION_TIMEOUT_MS);
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
const REAL_BUN_CANDIDATE = Bun.which("bun");
if (!REAL_BUN_CANDIDATE || !REAL_BUN_CANDIDATE.startsWith("/")) {
  throw new Error("absolute bun is required for the shell fixture");
}
const REAL_BUN: string = REAL_BUN_CANDIDATE;
const createdRoots: string[] = [];

function executable(path: string, body: string): void {
  writeFileSync(path, `#!/bin/bash\nset -eu\n${body}\n`, { mode: 0o700 });
  chmodSync(path, 0o700);
}

const fixedOutput = (...lines: string[]) => (lines.length === 0 ? "" : `${lines.join("\n")}\n`);

const HOSTILE_UTILITIES = [
  "mkdir",
  "chmod",
  "mktemp",
  "find",
  "cat",
  "cut",
  "tr",
  "sort",
  "tail",
  "rm",
  "install",
  "cp",
  "mv",
  "realpath",
  "dirname",
  "date",
  "pwd",
  "ls",
  "stat",
  "pg_dump",
  "psql",
  "bun",
  "brew",
  "restic",
] as const;

function installHostileUtility(bin: string, utility: (typeof HOSTILE_UTILITIES)[number]): void {
  const marker = `H3_PATH_INTERCEPT_${utility}`;
  const fixtureCat = Bun.which("cat");
  if (!fixtureCat || !fixtureCat.startsWith("/")) throw new Error("fixture requires absolute cat");
  const body =
    utility === "bun"
      ? `${JSON.stringify(fixtureCat)} >/dev/null\nprintf '%s\\n' 'credential-stdin-seen'\nprintf '%s\\n' 'credential-stdin-seen' >&2\nif [ -n "\${H3_TRACE:-}" ]; then printf '%s\\n' 'credential-stdin-seen' >> "\$H3_TRACE"; fi\nexit 74`
      : `printf '%s\\n' '${marker}'\nprintf '%s\\n' '${marker}' >&2\nif [ -n "\${H3_TRACE:-}" ]; then printf '%s\\n' '${marker}' >> "\$H3_TRACE"; fi\nexit 74`;
  executable(join(bin, utility), body);
}

function injectWorkspaceSignalHook(body: string, script: string): string {
  const anchor = "trap 'exit 143' TERM";
  const anchorIndex = body.indexOf(anchor);
  if (anchorIndex < 0 || body.indexOf(anchor, anchorIndex + anchor.length) >= 0) {
    throw new Error(`missing or non-unique TERM trap anchor in ${script}`);
  }
  const allocation = {
    "restore-drill.sh": {
      variable: "WORK_DIR",
      template: "minime-private.XXXXXX",
      statement: 'WORK_DIR="$($TRUSTED_MKTEMP -d "$TEMP_ROOT/minime-private.XXXXXX" 2>/dev/null)"',
    },
    "restore-pitr.sh": {
      variable: "WORK_DIR",
      template: "minime-private.XXXXXX",
      statement: 'WORK_DIR="$($TRUSTED_MKTEMP -d "$TEMP_ROOT/minime-private.XXXXXX" 2>/dev/null)"',
    },
    "promote-restore.sh": {
      variable: "CONNECTION_DIR",
      template: "minime-promote-libpq.XXXXXX",
      statement:
        'CONNECTION_DIR="$($TRUSTED_MKTEMP -d "$TEMP_ROOT/minime-promote-libpq.XXXXXX" 2>/dev/null)"',
    },
  } as const;
  const spec = allocation[script as keyof typeof allocation];
  if (!spec) throw new Error(`missing allocation specification for ${script}`);
  const countOccurrences = (value: string): number => body.split(value).length - 1;
  if (
    countOccurrences(spec.statement) !== 1 ||
    countOccurrences("$TRUSTED_MKTEMP -d") !== 1 ||
    countOccurrences(spec.template) !== 1
  ) {
    throw new Error(`missing or duplicate trusted ${spec.variable} allocation in ${script}`);
  }
  const allocationIndex = body.indexOf(spec.statement);
  const chmodStatement = `if ! "$TRUSTED_CHMOD" 700 "$${spec.variable}"`;
  const afterHook = `if [ "\${H3_SIGNAL_AFTER_WORKSPACE:-0}" = 1 ]; then kill -TERM "$$"; fi`;
  const chmodIndex = body.indexOf(chmodStatement, allocationIndex + spec.statement.length);
  if (allocationIndex < 0 || chmodIndex < 0 || chmodIndex <= allocationIndex) {
    throw new Error(`wrong ${spec.variable} allocation ordering in ${script}`);
  }
  const betweenAllocationAndChmod = body.slice(allocationIndex + spec.statement.length, chmodIndex);
  if (
    !betweenAllocationAndChmod.includes("\nfi\n") ||
    betweenAllocationAndChmod.includes("$TRUSTED_MKTEMP -d") ||
    betweenAllocationAndChmod.split(afterHook).length - 1 !== 1 ||
    countOccurrences(afterHook) !== 1
  ) {
    throw new Error(`wrong ${spec.variable} allocation boundary in ${script}`);
  }
  const message =
    script === "restore-drill.sh"
      ? "restore drill failed (workspace)"
      : script === "restore-pitr.sh"
        ? "restore pitr failed (workspace)"
        : "promotion failed (workspace)";
  const beforeHook = `\nif [ "\${H3_SIGNAL_BEFORE_WORKSPACE:-0}" = 1 ]; then\n  echo "${message}" >&2\n  kill -TERM "$$"\nfi\n`;
  const beforeIndex = anchorIndex + anchor.length;
  const withBefore = body.slice(0, beforeIndex) + beforeHook + body.slice(beforeIndex);
  const injectedBeforeIndex = withBefore.indexOf(beforeHook);
  const rewrittenAllocationIndex = withBefore.indexOf(spec.statement);
  const rewrittenAfterIndex = withBefore.indexOf(
    afterHook,
    rewrittenAllocationIndex + spec.statement.length,
  );
  const rewrittenChmodIndex = withBefore.indexOf(
    chmodStatement,
    rewrittenAllocationIndex + spec.statement.length,
  );
  if (
    !(
      anchorIndex < injectedBeforeIndex &&
      injectedBeforeIndex < rewrittenAllocationIndex &&
      rewrittenAllocationIndex < rewrittenAfterIndex &&
      rewrittenAfterIndex < rewrittenChmodIndex
    )
  ) {
    throw new Error(
      `production workspace signal hook is not ordered around ${spec.variable} allocation in ${script}`,
    );
  }
  return withBefore;
}

function injectCleanupEntryTrace(body: string, script: string): string {
  const functionName = script === "promote-restore.sh" ? "cleanup_promote" : "cleanup";
  const functionEntryPattern =
    functionName === "cleanup_promote" ? /^cleanup_promote\(\) \{\n/gm : /^cleanup\(\) \{\n/gm;
  const functionEntries = [...body.matchAll(functionEntryPattern)];
  if (functionEntries.length !== 1 || functionEntries[0]?.index === undefined) {
    throw new Error(`missing or non-unique ${functionName}() { in ${script}`);
  }
  const functionEntry = functionEntries[0]!;
  const markerLine = `  printf '%s\\n' cleanup-entry >> "$CLEANUP_ENTRY_TRACE"\n`;
  const entryIndex = functionEntry.index + functionEntry[0].length;
  const rewritten = body.slice(0, entryIndex) + markerLine + body.slice(entryIndex);
  const markerPattern = /^ {2}printf '%s\\n' cleanup-entry >> "\$CLEANUP_ENTRY_TRACE"$/gm;
  if (rewritten.match(markerPattern)?.length !== 1) {
    throw new Error(`wrong cleanup entry instrumentation in ${script}`);
  }
  return rewritten;
}

type WorkspaceSignalHookMode = "off" | "required";
type ResolverFailure = "mktemp" | "bun" | "pg_dump" | "restic";
type TempAliasMode = "physical" | "tmp-symlink" | "var-symlink" | "relative";

function shellFixture(
  options: {
    workspaceSignalHook?: WorkspaceSignalHookMode;
    resolverFailure?: ResolverFailure;
    tempAlias?: TempAliasMode;
    xtrace?: boolean;
  } = {},
) {
  const workspaceSignalHook = options.workspaceSignalHook ?? "off";
  const resolverFailure = options.resolverFailure;
  const tempAlias = options.tempAlias ?? "physical";
  const xtrace = options.xtrace ?? false;
  const root = realpathSync(mkdtempSync(join(tmpdir(), "minime-h3-shell-")));
  createdRoots.push(root);
  const bin = join(root, "hostile-path");
  const trustedBin = join(root, "trusted-bin");
  const brewPrefixReal = join(root, "brew-cellar");
  const brewPrefix = join(root, "brew-prefix");
  const formulaRoot = join(root, "formula-cellar");
  const formulaOpt = join(root, "formula-opt");
  const bunFormulaBin = join(formulaRoot, "bun", "bin");
  const resticFormulaBin = join(formulaRoot, "restic", "bin");
  const pgBin = join(brewPrefix, "bin");
  const pgBinPhysical = join(brewPrefixReal, "bin");
  const scratch = join(root, "tmp");
  const varScratch = join(root, "var");
  const tmpAlias = join(root, "tmp-alias");
  const varAlias = join(root, "var-alias");
  const foreign = join(root, "foreign");
  const trace = join(root, "trace");
  const cleanupEntryTrace = join(root, "cleanup-entry-trace");
  const rmTrace = join(root, "rm-trace");
  const immutableRoots = [bin, trustedBin, brewPrefixReal, pgBinPhysical, formulaRoot] as const;
  const fixtureRepo = join(root, "repo");
  const fixtureScripts = join(fixtureRepo, "scripts");
  const fixtureUtil = join(fixtureRepo, "src", "util");
  const dumpRoot = join(fixtureRepo, "db-dump");
  const legacyDump = join(root, "legacy-minime-drill-dump.sql");
  mkdirSync(bin, { mode: 0o700 });
  mkdirSync(trustedBin, { mode: 0o700 });
  mkdirSync(pgBinPhysical, { recursive: true, mode: 0o700 });
  mkdirSync(bunFormulaBin, { recursive: true, mode: 0o700 });
  mkdirSync(resticFormulaBin, { recursive: true, mode: 0o700 });
  symlinkSync(brewPrefixReal, brewPrefix, "dir");
  mkdirSync(formulaOpt, { mode: 0o700 });
  symlinkSync(join(formulaRoot, "bun"), join(formulaOpt, "bun"), "dir");
  symlinkSync(join(formulaRoot, "restic"), join(formulaOpt, "restic"), "dir");
  mkdirSync(scratch, { mode: 0o700 });
  mkdirSync(varScratch, { mode: 0o700 });
  symlinkSync(scratch, tmpAlias, "dir");
  symlinkSync(varScratch, varAlias, "dir");
  mkdirSync(foreign, { mode: 0o700 });
  mkdirSync(fixtureScripts, { recursive: true, mode: 0o700 });
  mkdirSync(fixtureUtil, { recursive: true, mode: 0o700 });
  mkdirSync(dumpRoot, { mode: 0o700 });
  writeFileSync(trace, "", { mode: 0o600 });
  writeFileSync(cleanupEntryTrace, "", { mode: 0o600 });
  writeFileSync(rmTrace, "", { mode: 0o600 });
  for (const name of [
    "restore-drill.sh",
    "restore-pitr.sh",
    "promote-restore.sh",
    "pick-snapshot.ts",
    "snapshot-manifest.ts",
    "validate-recovery-endpoints.ts",
    "libpq-service.ts",
  ]) {
    const source = join(REPO, "scripts", name);
    let body = readFileSync(source, "utf8");
    if (name === "restore-drill.sh") {
      body = body.replace("/tmp/minime-drill-dump.sql", legacyDump);
    }
    if (name === "restore-pitr.sh") {
      body = body.replace(
        'RESTORE_URL="postgres://minime:minime@localhost:5432/$RESTORE_DB"',
        'RESTORE_URL="postgres://h3-restore-user:restore-credential-sentinel@localhost:5432/minime_restore"',
      );
    }
    if (name.endsWith(".sh")) {
      // Replace every fixed production candidate with an absolute, fixture-owned
      // seam.  This keeps PATH hostile-only while still exercising the resolver.
      for (const utility of [
        ...HOSTILE_UTILITIES,
        "cat",
        "cut",
        "tr",
        "sort",
        "tail",
        "brew",
        "bun",
        "restic",
      ]) {
        const seam =
          utility === "pg_dump" || utility === "psql"
            ? join(pgBinPhysical, utility)
            : join(trustedBin, utility);
        for (const prefix of ["/bin", "/usr/bin", "/opt/homebrew/bin", "/usr/local/bin"]) {
          body = body.replaceAll(`${prefix}/${utility}`, seam);
        }
        if (resolverFailure === utility) {
          body = body.replaceAll(seam, join(root, `missing-${utility}`));
        }
      }
      body = body.replaceAll("/opt/homebrew/opt/bun/bin", join(formulaOpt, "bun", "bin"));
      body = body.replaceAll("/usr/local/opt/bun/bin", join(formulaOpt, "bun", "bin"));
      body = body.replaceAll("/opt/homebrew/opt/restic/bin", join(formulaOpt, "restic", "bin"));
      body = body.replaceAll("/usr/local/opt/restic/bin", join(formulaOpt, "restic", "bin"));
      body = body.replaceAll(
        "brew --prefix postgresql@17",
        `${join(trustedBin, "brew")} --prefix postgresql@17`,
      );
      body = body.replaceAll('PGBIN="$(brew --prefix postgresql@17)/bin"', `PGBIN="${pgBin}"`);
    }
    if (name.endsWith(".sh") && workspaceSignalHook === "required") {
      body = injectWorkspaceSignalHook(body, name);
      body = injectCleanupEntryTrace(body, name);
    }
    const target = join(fixtureScripts, name);
    writeFileSync(target, body, { mode: name.endsWith(".sh") ? 0o700 : 0o600 });
    if (name.endsWith(".sh")) chmodSync(target, 0o700);
  }
  writeFileSync(
    join(fixtureUtil, "libpq-service.ts"),
    readFileSync(join(REPO, "src", "util", "libpq-service.ts")),
    { mode: 0o600 },
  );
  writeFileSync(
    join(fixtureUtil, "config.ts"),
    readFileSync(join(REPO, "src", "util", "config.ts")),
    { mode: 0o600 },
  );
  const fixtureOps = join(fixtureRepo, "src", "ops");
  mkdirSync(fixtureOps, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(fixtureOps, "snapshot-manifest.ts"),
    readFileSync(join(REPO, "src", "ops", "snapshot-manifest.ts")),
    { mode: 0o600 },
  );
  writeFileSync(
    join(fixtureOps, "recovery-endpoints.ts"),
    readFileSync(join(REPO, "src", "ops", "recovery-endpoints.ts")),
    { mode: 0o600 },
  );

  const fixtureUtility = (name: string): string => {
    const path = Bun.which(name);
    if (!path || !path.startsWith("/")) throw new Error(`fixture requires absolute ${name}`);
    return JSON.stringify(path);
  };
  const FIXTURE_STAT = fixtureUtility("stat");
  const FIXTURE_GREP = fixtureUtility("grep");
  const FIXTURE_MKDIR = fixtureUtility("mkdir");
  const FIXTURE_CHMOD = fixtureUtility("chmod");
  const modeFn = `mode_of() { ${FIXTURE_STAT} -c "%a" "$1" 2>/dev/null || ${FIXTURE_STAT} -f "%Lp" "$1"; }`;
  const envGuard = `
if [ "\${H3_ENV_GUARD:-0}" = 1 ]; then
  [ -z "\${DATABASE_URL:-}" ] || { printf '%s\\n' H3_ENV_URL_LEAK >&2; exit 73; }
  [ -z "\${ADMIN_URL:-}" ] || { printf '%s\\n' H3_ENV_URL_LEAK >&2; exit 73; }
  [ -z "\${DRILL_URL:-}" ] || { printf '%s\\n' H3_ENV_URL_LEAK >&2; exit 73; }
  [ -z "\${LIVE_URL:-}" ] || { printf '%s\\n' H3_ENV_URL_LEAK >&2; exit 73; }
  [ -z "\${RESTORE_URL:-}" ] || { printf '%s\\n' H3_ENV_URL_LEAK >&2; exit 73; }
  [ -z "\${SOURCE_URL:-}" ] || { printf '%s\\n' H3_ENV_URL_LEAK >&2; exit 73; }
  [ -z "\${ADMIN_URL_VALUE:-}" ] || { printf '%s\\n' H3_ENV_URL_LEAK >&2; exit 73; }
  [ -z "\${DRILL_URL_VALUE:-}" ] || { printf '%s\\n' H3_ENV_URL_LEAK >&2; exit 73; }
  [ -z "\${LIVE_URL_VALUE:-}" ] || { printf '%s\\n' H3_ENV_URL_LEAK >&2; exit 73; }
  [ -z "\${RESTORE_URL_VALUE:-}" ] || { printf '%s\\n' H3_ENV_URL_LEAK >&2; exit 73; }
  [ -z "\${raw:-}" ] || { printf '%s\\n' H3_ENV_URL_LEAK >&2; exit 73; }
fi`;
  executable(
    join(trustedBin, "brew"),
    `${envGuard}
if [ "\${H3_TRUSTED_UTILITY_FAILURE:-}" = brew ]; then printf "%s\\n" "H3_TRUSTED_INTERCEPT_brew"; printf "%s\\n" "H3_TRUSTED_INTERCEPT_brew" >&2; printf "%s\\n" "H3_TRUSTED_INTERCEPT_brew" >> "$H3_TRACE"; exit 74; fi
if [ "\${1:-}" = "--prefix" ]; then printf "%s\\n" "$H3_FAKE_PREFIX"; exit 0; fi; exit 1`,
  );
  executable(
    join(pgBinPhysical, "pg_dump"),
    `${envGuard}
${modeFn}
if [ "\${H3_TRUSTED_UTILITY_FAILURE:-}" = pg_dump ]; then
  printf '%s\\n' 'H3_TRUSTED_INTERCEPT_pg_dump'
  printf '%s\\n' 'H3_TRUSTED_INTERCEPT_pg_dump' >&2
  printf '%s\\n' 'H3_TRUSTED_INTERCEPT_pg_dump' >> "$H3_TRACE"
  exit 74
fi
if [ "\${H3_FIXTURE_PROBE:-0}" = 1 ]; then exit 0; fi
if [ "\${H3_HOSTILE_CHILD_OUTPUT:-0}" = 1 ]; then
  printf '%s\\n' "\${H3_PGDUMP_SENTINEL:-pg_dump-hostile-sentinel}"
  printf '%s\\n' "\${H3_PGDUMP_SENTINEL:-pg_dump-hostile-sentinel}" >&2
fi
argv="$*"
out=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-f" ]; then out="$2"; shift 2; else shift; fi
done
[ -n "$out" ] || { echo "fixture pg_dump requires -f" >&2; exit 64; }
[ "\${PGSERVICE:-}" = minime_ephemeral ] ||
  { echo "fixture pg_dump requires PGSERVICE" >&2; exit 65; }
[ -n "\${PGSERVICEFILE:-}" ] && [ -f "$PGSERVICEFILE" ] ||
  { echo "fixture pg_dump requires PGSERVICEFILE" >&2; exit 66; }
service_mode="$(mode_of "$PGSERVICEFILE")"
[ "$service_mode" = 600 ] ||
  { echo "service mode was $service_mode" >&2; exit 67; }
${FIXTURE_GREP} -q '^\\[minime_ephemeral\\]$' "$PGSERVICEFILE" || exit 68
${FIXTURE_GREP} -q '^host=localhost$' "$PGSERVICEFILE" || exit 69
${FIXTURE_GREP} -q '^port=5432$' "$PGSERVICEFILE" || exit 70
${FIXTURE_GREP} -q '^dbname=minime_test$' "$PGSERVICEFILE" || exit 71
${FIXTURE_GREP} -q 'postgres://' "$PGSERVICEFILE" && exit 72
case "$argv" in *postgres://*) echo "database URL leaked on argv" >&2; exit 66 ;; esac
[ -f "$out" ] || { echo "dump target was not reserved" >&2; exit 67; }
mode="$(mode_of "$out")"
[ "$mode" = 600 ] || { echo "dump target mode was $mode before write" >&2; exit 68; }
printf 'command=pg_dump mode_before=%s service_mode=%s\n' "$mode" "$service_mode" >> "$H3_TRACE"
if [ "\${H3_PGDUMP_FAILURE:-0}" = 1 ]; then exit 13; fi
if [ "\${H3_SIGNAL_PARENT:-0}" = 1 ]; then
  kill -TERM "$PPID"
  exit 143
fi
if [ "\${H3_PGDUMP_SIGNAL_SUCCESS:-0}" = 1 ]; then
  printf '%s\n' 'COPY public.schema_migrations (name) FROM stdin;' '020.sql' '\\.' 'COPY public.tasks (id) FROM stdin;' '1' '\\.' 'COPY public.people (id) FROM stdin;' '1' '\\.' 'COPY public.journal_entries (id) FROM stdin;' '1' '\\.' 'COPY public.chunks (id) FROM stdin;' '1' '\\.' 'COPY public.events (id) FROM stdin;' '1' '\\.' > "$out"
  kill -TERM "$PPID"
  exit 0
fi
printf '%s\n' 'COPY public.schema_migrations (name) FROM stdin;' '020.sql' '\\.' 'COPY public.tasks (id) FROM stdin;' '1' '\\.' 'COPY public.people (id) FROM stdin;' '1' '\\.' 'COPY public.journal_entries (id) FROM stdin;' '1' '\\.' 'COPY public.chunks (id) FROM stdin;' '1' '\\.' 'COPY public.events (id) FROM stdin;' '1' '\\.' > "$out"
if [ "\${H3_PGDUMP_REPLACE:-}" = symlink ]; then
  /bin/rm -f -- "$out"
  printf '%s\n' '-- foreign target --' > "\${H3_PGDUMP_FOREIGN}"
  /bin/ln -s "\${H3_PGDUMP_FOREIGN}" "$out"
elif [ "\${H3_PGDUMP_REPLACE:-}" = directory ]; then
  /bin/rm -f -- "$out"
  /bin/mkdir "$out"
elif [ "\${H3_PGDUMP_REPLACE:-}" = regular ]; then
  /bin/rm -f -- "$out"
  printf '%s\n' '-- replacement dump --' > "$out"
fi`,
  );
  executable(
    join(pgBinPhysical, "psql"),
    `${envGuard}
${modeFn}
if [ "\${H3_TRUSTED_UTILITY_FAILURE:-}" = psql ]; then
  printf '%s\\n' 'H3_TRUSTED_INTERCEPT_psql'
  printf '%s\\n' 'H3_TRUSTED_INTERCEPT_psql' >&2
  printf '%s\\n' 'H3_TRUSTED_INTERCEPT_psql' >> "$H3_TRACE"
  exit 74
fi
if [ "\${H3_FIXTURE_PROBE:-0}" = 1 ]; then exit 0; fi
if [ "\${H3_HOSTILE_CHILD_OUTPUT:-0}" = 1 ] && [[ " $* " != *"-F"* ]]; then
  printf '%s\\n' "\${H3_PSQL_SENTINEL:-psql-hostile-sentinel}"
  printf '%s\\n' "\${H3_PSQL_SENTINEL:-psql-hostile-sentinel}" >&2
fi
printf 'command=psql\n' >> "$H3_TRACE"
if [ -n "\${PGSERVICEFILE:-}" ]; then
  [ "\${PGSERVICE:-}" = minime_ephemeral ] || exit 74
  [ -f "$PGSERVICEFILE" ] || exit 75
  psql_service_mode="$(mode_of "$PGSERVICEFILE")"
  [ "$psql_service_mode" = 600 ] || exit 76
  ${FIXTURE_GREP} -q '^\\[minime_ephemeral\\]$' "$PGSERVICEFILE" || exit 77
  printf 'psql_service_mode=%s\n' "$psql_service_mode" >> "$H3_TRACE"
fi
case "$*" in
  *"select 1 from pg_database where datname = 'minime_restore'"*) printf '1\n'; exit 0 ;;
  *"select count(*) from pg_stat_activity"*) printf '0\n'; exit 0 ;;
  *"select 'm', name"*) printf 'm\t020.sql\t-\nc\tchunks\t1\nc\tevents\t1\nc\tjournal_entries\t1\nc\tpeople\t1\nc\ttasks\t1\n'; exit 0 ;;
esac
if [ "\${H3_PSQL_FAILURE:-0}" = 1 ]; then exit 7; fi
if [ "\${H3_VALIDATE_FAILURE:-0}" = 1 ] && [[ " $* " = *" ON_ERROR_STOP=1 "* ]] && [[ " $* " = *"select 1"* ]]; then
  exit 9
fi
if [ "\${H3_REPLAY_ERRORS:-0}" = 1 ] && [[ " $* " = *" -f "* ]]; then
  printf 'replay_stderr_mode=%s\n' "$(mode_of "\${H3_REPLAY_ERR_FILE:-/dev/fd/2}")" >> "$H3_TRACE"
  printf 'SQL_ERROR_SENTINEL\n' >&2
  if [[ " $* " = *" ON_ERROR_STOP=1 "* ]]; then exit 7; fi
fi
exit 0`,
  );
  executable(
    join(trustedBin, "restic"),
    `${envGuard}
${modeFn}
if [ "\${H3_TRUSTED_UTILITY_FAILURE:-}" = restic ]; then
  printf '%s\\n' 'H3_TRUSTED_INTERCEPT_restic'
  printf '%s\\n' 'H3_TRUSTED_INTERCEPT_restic' >&2
  printf '%s\\n' 'H3_TRUSTED_INTERCEPT_restic' >> "$H3_TRACE"
  exit 74
fi
if [ "\${H3_HOSTILE_CHILD_OUTPUT:-0}" = 1 ]; then
  printf '%s\\n' "\${H3_RESTIC_SENTINEL:-restic-hostile-sentinel}"
  printf '%s\\n' "\${H3_RESTIC_SENTINEL:-restic-hostile-sentinel}" >&2
fi
printf 'command=restic\n' >> "$H3_TRACE"
if [ "\${H3_RESTIC_FAILURE:-0}" = 1 ] && {
  [ "\${H3_RESTIC_RESTORE_ONLY:-0}" != 1 ] || [ "\${1:-}" = "restore" ];
}; then exit 8; fi
if [ "\${1:-}" = "snapshots" ]; then printf '[{"id":"snapshot-id","time":"2026-07-23T00:00:00Z","tags":["db-snap"]}]\n'; exit 0; fi
if [ "\${1:-}" = "restore" ]; then
  target=""
  while [ "$#" -gt 0 ]; do
    if [ "$1" = "--target" ]; then target="$2"; shift 2; else shift; fi
  done
  case "\${H3_ARCHIVE_CASE:-}" in
    leaf-symlink)
      "${FIXTURE_MKDIR}" -p "$target/host/db-dump"
      printf '%s\n' 'foreign archive sentinel' > "\${H3_ARCHIVE_OUTSIDE}"
      /bin/ln -s "\${H3_ARCHIVE_OUTSIDE}" "$target/host/db-dump/minime.sql"
      exit 0
      ;;
    parent-symlink)
      "${FIXTURE_MKDIR}" -p "$target/host"
      "${FIXTURE_MKDIR}" -p "\${H3_ARCHIVE_OUTSIDE}"
      /bin/ln -s "\${H3_ARCHIVE_OUTSIDE}" "$target/host/db-dump"
      exit 0
      ;;
    multiple)
      "${FIXTURE_MKDIR}" -p "$target/host/db-dump" "$target/second/db-dump"
      printf '%s\n' '-- fictional restored minime_test dump --' > "$target/host/db-dump/minime.sql"
      printf '%s\n' '-- second fictional restored dump --' > "$target/second/db-dump/minime.sql"
      exit 0
      ;;
  esac
  "${FIXTURE_MKDIR}" -p "$target/host/db-dump"
  "${FIXTURE_CHMOD}" 700 "$target" "$target/host" "$target/host/db-dump"
  printf '%s\n' 'COPY public.schema_migrations (name) FROM stdin;' '020.sql' '\\.' 'COPY public.tasks (id) FROM stdin;' '1' '\\.' 'COPY public.people (id) FROM stdin;' '1' '\\.' 'COPY public.journal_entries (id) FROM stdin;' '1' '\\.' 'COPY public.chunks (id) FROM stdin;' '1' '\\.' 'COPY public.events (id) FROM stdin;' '1' '\\.' > "$target/host/db-dump/minime.sql"
  "${FIXTURE_CHMOD}" 600 "$target/host/db-dump/minime.sql"
  "$H3_REAL_BUN" run "$H3_FIXTURE_SNAPSHOT_SCRIPT" write "$target/host/db-dump/minime.sql" "$target/host/db-dump/minime.manifest.json" >/dev/null 2>&1
  printf 'command=restic_restore mode=%s dump_mode=%s\n' "$(mode_of "$target")" \
    "$(mode_of "$target/host/db-dump/minime.sql")" >> "$H3_TRACE"
fi
exit 0`,
  );
  executable(
    join(trustedBin, "bun"),
    `${envGuard}
if [ "\${H3_TRUSTED_UTILITY_FAILURE:-}" = bun ]; then
  printf '%s\\n' 'H3_TRUSTED_INTERCEPT_bun'
  printf '%s\\n' 'H3_TRUSTED_INTERCEPT_bun' >&2
  printf '%s\\n' 'H3_TRUSTED_INTERCEPT_bun' >> "$H3_TRACE"
  exit 74
fi
for arg in "$@"; do
  case "$arg" in
    *libpq-service.ts)
      if [ "\${H3_BRIDGE_FAILURE:-0}" = 1 ]; then
        printf '%s\\n' "\${H3_BRIDGE_SENTINEL:-bridge-failure-sentinel}"
        printf '%s\\n' "\${H3_BRIDGE_SENTINEL:-bridge-failure-sentinel}" >&2
        exit 27
      fi
      ;;
  esac
  case "$arg" in
    *pick-snapshot.ts) printf "snapshot-id\\t2026-07-23T00:00:00Z\\n"; exit 0 ;;
  esac
done
  exec "$H3_REAL_BUN" "$@"`,
  );
  copyFileSync(join(trustedBin, "bun"), join(bunFormulaBin, "bun"));
  chmodSync(join(bunFormulaBin, "bun"), 0o700);
  copyFileSync(join(trustedBin, "restic"), join(resticFormulaBin, "restic"));
  chmodSync(join(resticFormulaBin, "restic"), 0o700);
  for (const utility of HOSTILE_UTILITIES) installHostileUtility(bin, utility);
  for (const utility of [...HOSTILE_UTILITIES, "cat", "cut", "tr", "sort", "tail"]) {
    if (
      utility === "find" ||
      utility === "bun" ||
      utility === "brew" ||
      utility === "restic" ||
      utility === "pg_dump" ||
      utility === "psql"
    )
      continue;
    const real = Bun.which(utility);
    if (!real) throw new Error(`fixture requires trusted ${utility}`);
    const marker = `H3_TRUSTED_INTERCEPT_${utility}`;
    const rmTraceLine =
      utility === "rm"
        ? `if [ -n "\${RM_TRACE:-}" ]; then printf '%s\\n' rm >> "\$RM_TRACE"; fi\n`
        : "";
    executable(
      join(trustedBin, utility),
      `${envGuard}
${rmTraceLine}if [ "\${H3_TRUSTED_UTILITY_FAILURE:-}" = ${JSON.stringify(utility)} ]; then
  printf '%s\\n' '${marker}'
  printf '%s\\n' '${marker}' >&2
  if [ -n "\${H3_TRACE:-}" ]; then printf '%s\\n' '${marker}' >> "\$H3_TRACE"; fi
  exit 74
fi
exec ${JSON.stringify(real)} "$@"`,
    );
  }
  const realFind = Bun.which("find");
  if (!realFind) throw new Error("fixture requires trusted find");
  executable(
    join(trustedBin, "find"),
    `${envGuard}
if [ "\${H3_TRUSTED_UTILITY_FAILURE:-}" = find ]; then
  printf '%s\\n' 'H3_TRUSTED_INTERCEPT_find'
  printf '%s\\n' 'H3_TRUSTED_INTERCEPT_find' >&2
  printf '%s\\n' 'H3_TRUSTED_INTERCEPT_find' >> "\$H3_TRACE"
  exit 74
fi
if [ "\${H3_ARCHIVE_CASE:-}" = malformed ]; then
  printf '%s\\n' "\${H3_MALFORMED_FIND:-/outside/malformed/minime.sql}"
  exit 0
fi
exec ${JSON.stringify(realFind)} "\$@"`,
  );

  // PATH is deliberately hostile-only; every script candidate is rewritten to
  // one of these explicit absolute fixture seams before the child is spawned.
  // No `process.env.PATH` suffix and no `Bun.which()` result is inherited by
  // a shell child.  The wrappers in `bin` emit a credential/path marker if a
  // script accidentally consults PATH, so an otherwise successful run still
  // fails the no-marker assertion.
  const probeEnv = {
    ...process.env,
    PATH: bin,
    H3_FAKE_PREFIX: brewPrefix,
    PGBIN: pgBin,
    H3_TRACE: trace,
    H3_FIXTURE_SNAPSHOT_SCRIPT: join(fixtureScripts, "snapshot-manifest.ts"),
  };
  const resolvedPgbin = Bun.spawnSync([join(trustedBin, "brew"), "--prefix", "postgresql@17"], {
    env: probeEnv,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (resolvedPgbin.exitCode !== 0 || resolvedPgbin.stdout.toString().trim() !== brewPrefix) {
    throw new Error("fixture brew prefix did not resolve to its PostgreSQL bin");
  }
  for (const command of ["pg_dump", "psql"]) {
    const probe = Bun.spawnSync([join(pgBinPhysical, command), "--fixture-probe"], {
      env: { ...probeEnv, H3_FIXTURE_PROBE: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    if (probe.exitCode !== 0) throw new Error(`fixture ${command} probe failed`);
  }

  function run(
    script: "restore-drill.sh" | "restore-pitr.sh" | "promote-restore.sh",
    extra: Record<string, string | undefined> = {},
  ) {
    const tempRoot =
      tempAlias === "tmp-symlink"
        ? tmpAlias
        : tempAlias === "var-symlink"
          ? varAlias
          : tempAlias === "relative"
            ? "relative-tmp"
            : scratch;
    const env: Record<string, string> = {
      ...Object.fromEntries(
        Object.entries(process.env).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      ),
      PATH: bin,
      TMPDIR: tempRoot,
      H3_TRACE: trace,
      CLEANUP_ENTRY_TRACE: cleanupEntryTrace,
      RM_TRACE: rmTrace,
      H3_FAKE_PREFIX: brewPrefix,
      PGBIN: pgBin,
      H3_REAL_BUN: REAL_BUN,
      H3_FIXTURE_SNAPSHOT_SCRIPT: join(fixtureScripts, "snapshot-manifest.ts"),
      DATABASE_URL: "postgres://h3-source-user:credential-sentinel@localhost:5432/minime_test",
      ADMIN_URL: "postgres://h3-admin-user:admin-credential-sentinel@localhost:5432/postgres",
      DRILL_URL: "postgres://h3-drill-user:drill-credential-sentinel@localhost:5432/minime_drill",
      LIVE_URL: "postgres://h3-live-user:live-credential-sentinel@localhost:5432/minime",
      RESTORE_URL:
        "postgres://h3-restore-user:restore-credential-sentinel@localhost:5432/minime_restore",
      PGDATABASE: "postgres://invalid:invalid@127.0.0.1:1/not_a_database",
      TIME: "2026-07-23 03:00",
    };
    // Do not let the host's provider/install knobs leak into the fixture.  The
    // copied scripts receive only deterministic fixture-owned absolute seams.
    Reflect.deleteProperty(env, "BUN_INSTALL");
    Reflect.deleteProperty(env, "RESTIC_BIN");
    Reflect.deleteProperty(env, "RESTIC_REPOSITORY");
    for (const [key, value] of Object.entries(extra)) {
      if (value === undefined) delete env[key];
      else env[key] = value;
    }
    if (
      env.H3_PRESERVE_RESTIC_BIN !== "1" &&
      (env.RESTIC_REPOSITORY || env.RESTIC_BIN) &&
      env.H3_FORMULA_RESTIC !== "1"
    ) {
      env.RESTIC_BIN = join(trustedBin, "restic");
    } else if (env.H3_PRESERVE_RESTIC_BIN !== "1") {
      Reflect.deleteProperty(env, "RESTIC_BIN");
    }
    if (resolverFailure === "restic" && (env.RESTIC_REPOSITORY || env.RESTIC_BIN)) {
      env.RESTIC_BIN = join(root, "missing-restic");
    }
    const autoExport = env.H3_AUTO_EXPORT === "1";
    Reflect.deleteProperty(env, "H3_AUTO_EXPORT");
    const command = autoExport
      ? ["/bin/bash", ...(xtrace ? ["-x"] : []), "-a", join(fixtureScripts, script)]
      : ["/bin/bash", ...(xtrace ? ["-x"] : []), join(fixtureScripts, script)];
    const proc = Bun.spawnSync(command, {
      cwd: foreign,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    return {
      code: proc.exitCode,
      out: proc.stdout.toString(),
      err: proc.stderr.toString(),
      trace: readFileSync(trace, "utf8"),
      cleanupEntryTrace,
      rmTrace,
      immutableRoots,
      root,
      scratch,
      tempRoot,
      varScratch,
      tmpAlias,
      varAlias,
      foreign,
      hostileBin: bin,
      trustedBin,
      pgBin,
      fixtureRepo,
      dumpRoot,
      legacyDump,
    };
  }

  return {
    root,
    scratch,
    varScratch,
    tmpAlias,
    varAlias,
    foreign,
    trace,
    cleanupEntryTrace,
    rmTrace,
    immutableRoots,
    hostileBin: bin,
    trustedBin,
    pgBin,
    fixtureRepo,
    fixtureScripts,
    dumpRoot,
    legacyDump,
    run,
  };
}

function expectNoConnectionSecrets(result: {
  root: string;
  out: string;
  err: string;
  trace: string;
}): void {
  const visible = `${result.out}\n${result.err}\n${result.trace}`;
  for (const secret of [
    "postgres://h3-source-user:credential-sentinel@localhost:5432/minime_test",
    "postgres://h3-admin-user:admin-credential-sentinel@localhost:5432/postgres",
    "postgres://h3-drill-user:drill-credential-sentinel@localhost:5432/minime_drill",
    "postgres://h3-live-user:live-credential-sentinel@localhost:5432/minime",
    "postgres://h3-restore-user:restore-credential-sentinel@localhost:5432/minime_restore",
    "h3-source-user",
    "h3-admin-user",
    "h3-drill-user",
    "h3-live-user",
    "h3-restore-user",
    "credential-sentinel",
    "admin-credential-sentinel",
    "drill-credential-sentinel",
    "live-credential-sentinel",
    "restore-credential-sentinel",
    "admin-host.invalid",
    "drill-host.invalid",
    "live-host.invalid",
    "restore-host.invalid",
    "admin_db",
    "drill_db",
    "live_db",
    "restore_db",
  ]) {
    expect(visible).not.toContain(secret);
  }
  expect(visible).not.toMatch(/psql[^\n]*\s-d\s/);
  expect(visible).not.toContain("postgres://");
}

test("hostile PATH Bun wrapper consumes fictional stdin and emits only its fixed marker", () => {
  const f = shellFixture();
  const fictional = "postgres://fictional-user:fictional-secret@fictional-host/db";
  const r = Bun.spawnSync([join(f.hostileBin, "bun")], {
    env: { PATH: f.hostileBin, H3_TRACE: f.trace },
    stdin: new TextEncoder().encode(fictional),
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(r.exitCode).toBe(74);
  expect(r.stdout.toString()).toBe("credential-stdin-seen\n");
  expect(r.stderr.toString()).toBe("credential-stdin-seen\n");
  expect(readFileSync(f.trace, "utf8")).toBe("credential-stdin-seen\n");
  expect(r.stdout.toString()).not.toContain(fictional);
  expect(r.stderr.toString()).not.toContain(fictional);
  expect(readFileSync(f.trace, "utf8")).not.toContain(fictional);
});

function readFixtureFiles(root: string, ignoredDirectories: readonly string[] = []): string[] {
  const rootReal = realpathSync(root);
  const files: string[] = [];
  const maxFiles = 4096;
  const maxBytes = 4 * 1024 * 1024;
  const visit = (directory: string): void => {
    if (files.length > maxFiles) throw new Error("fixture file bound exceeded");
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        if (ignoredDirectories.includes(path)) continue;
        visit(path);
      } else if (stat.isFile() && stat.size <= maxBytes) {
        files.push(readFileSync(path, "utf8"));
      }
    }
  };
  visit(rootReal);
  return files;
}

function expectNoMarker(
  result: { root: string; out: string; err: string; trace: string },
  marker: string,
): void {
  expect(`${result.out}\n${result.err}\n${result.trace}`).not.toContain(marker);
  expect(readFixtureFiles(result.root).join("\n")).not.toContain(marker);
}

function expectNoPathInterception(result: {
  root: string;
  hostileBin: string;
  trustedBin: string;
  immutableRoots: readonly string[];
  out: string;
  err: string;
  trace: string;
}): void {
  const visible = `${result.out}\n${result.err}\n${result.trace}`;
  expect(visible).not.toMatch(/H3_PATH_INTERCEPT_[A-Za-z0-9_]+/);
  expect(visible).not.toMatch(/H3_TRUSTED_INTERCEPT_[A-Za-z0-9_]+/);
  expect(visible).not.toContain("credential-stdin-seen");
  const immutable = [result.hostileBin, result.trustedBin, ...result.immutableRoots];
  expect(readFixtureFiles(result.root, immutable).join("\n")).not.toMatch(
    /H3_PATH_INTERCEPT_[A-Za-z0-9_]+|H3_TRUSTED_INTERCEPT_[A-Za-z0-9_]+|credential-stdin-seen/,
  );
}

function expectTrustedInterception(result: { trace: string }, utility: string): void {
  expect(result.trace).toContain(`H3_TRUSTED_INTERCEPT_${utility}`);
}

const hostileRows = [
  {
    name: "restore-drill pg_dump failure",
    script: "restore-drill.sh",
    child: "pg_dump",
    phase: "fresh source dump",
    env: { H3_PGDUMP_FAILURE: "1" },
    fake: "writes stdout/stderr marker, then exits 13",
    marker: "H3_MATRIX_DRILL_PGDUMP",
    expectedExit: 1,
    expectedStdout: fixedOutput("==> creating fresh source database dump"),
    expectedStderr: fixedOutput("restore drill failed (pg_dump)"),
  },
  {
    name: "restore-drill restic failure",
    script: "restore-drill.sh",
    child: "restic",
    phase: "latest snapshot restore",
    env: { RESTIC_REPOSITORY: "test:repo", H3_RESTIC_FAILURE: "1" },
    fake: "writes stdout/stderr marker, then exits 8",
    marker: "H3_MATRIX_DRILL_RESTIC",
    expectedExit: 1,
    expectedStdout: fixedOutput("==> restoring latest private snapshot"),
    expectedStderr: fixedOutput("restore drill failed (restic_snapshots)"),
  },
  {
    name: "restore-drill psql validation failure",
    script: "restore-drill.sh",
    child: "psql",
    phase: "scratch validation",
    env: { H3_VALIDATE_FAILURE: "1" },
    fake: "writes stdout/stderr marker, then exits 9 for ON_ERROR_STOP",
    marker: "H3_MATRIX_DRILL_PSQL",
    expectedExit: 9,
    expectedStdout: fixedOutput(
      "==> creating fresh source database dump",
      "==> restoring into private scratch database",
      "==> validating restored database",
    ),
    expectedStderr: fixedOutput("restore validation failed; promotion refused"),
  },
  {
    name: "restore-drill psql replay failure",
    script: "restore-drill.sh",
    child: "psql",
    phase: "scratch replay",
    env: { H3_REPLAY_ERRORS: "1" },
    fake: "writes stdout/stderr marker, then exits 7",
    marker: "H3_MATRIX_DRILL_REPLAY",
    expectedExit: 1,
    expectedStdout: fixedOutput(
      "==> creating fresh source database dump",
      "==> restoring into private scratch database",
    ),
    expectedStderr: fixedOutput("restore drill failed (psql)"),
  },
  {
    name: "restore-pitr restic failure",
    script: "restore-pitr.sh",
    child: "restic",
    phase: "snapshot listing",
    env: { RESTIC_REPOSITORY: "test:repo", H3_RESTIC_FAILURE: "1" },
    fake: "writes stdout/stderr marker, then exits 8",
    marker: "H3_MATRIX_PITR_RESTIC",
    expectedExit: 1,
    expectedStdout: fixedOutput("==> selecting private snapshot"),
    expectedStderr: fixedOutput("restore pitr failed (restic_snapshots)"),
  },
  {
    name: "restore-pitr restic restore failure",
    script: "restore-pitr.sh",
    child: "restic",
    phase: "selected snapshot restore",
    env: { RESTIC_REPOSITORY: "test:repo", H3_RESTIC_FAILURE: "1", H3_RESTIC_RESTORE_ONLY: "1" },
    fake: "writes stdout/stderr marker, then exits 8 for restore",
    marker: "H3_MATRIX_PITR_RESTORE",
    expectedExit: 1,
    expectedStdout: fixedOutput(
      "==> selecting private snapshot",
      "==> restoring selected private snapshot",
    ),
    expectedStderr: fixedOutput("restore pitr failed (restic_restore)"),
  },
  {
    name: "restore-pitr replay failure",
    script: "restore-pitr.sh",
    child: "psql",
    phase: "dump replay",
    env: { RESTIC_REPOSITORY: "test:repo", H3_REPLAY_ERRORS: "1" },
    fake: "writes stdout/stderr marker and emits one anchored replay error",
    marker: "H3_MATRIX_PITR_PSQL",
    expectedExit: 4,
    expectedStdout: fixedOutput(
      "==> selecting private snapshot",
      "==> restoring selected private snapshot",
      "==> restoring into private scratch database",
    ),
    expectedStderr: fixedOutput("restore validation failed; promotion refused"),
  },
  {
    name: "restore-pitr validation failure",
    script: "restore-pitr.sh",
    child: "psql",
    phase: "post-replay validation",
    env: { RESTIC_REPOSITORY: "test:repo", H3_VALIDATE_FAILURE: "1" },
    fake: "writes stdout/stderr marker, then exits 9 for ON_ERROR_STOP",
    marker: "H3_MATRIX_PITR_VALIDATE",
    expectedExit: 4,
    expectedStdout: fixedOutput(
      "==> selecting private snapshot",
      "==> restoring selected private snapshot",
      "==> restoring into private scratch database",
    ),
    expectedStderr: fixedOutput("restore validation failed; promotion refused"),
  },
  {
    name: "promote pg_dump failure",
    script: "promote-restore.sh",
    child: "pg_dump",
    phase: "pre-promote safety dump",
    env: { H3_PGDUMP_FAILURE: "1" },
    fake: "writes stdout/stderr marker, then exits 13",
    marker: "H3_MATRIX_PROMOTE_PGDUMP",
    expectedExit: 13,
    expectedStdout: fixedOutput("==> dumping live database to canonical pre-promote safety net"),
    expectedStderr: fixedOutput(),
  },
  {
    name: "promote pg_dump parent TERM",
    script: "promote-restore.sh",
    child: "pg_dump",
    phase: "pre-promote safety dump",
    env: { H3_SIGNAL_PARENT: "1" },
    fake: "writes stdout/stderr marker, sends TERM to parent, exits 143",
    marker: "H3_MATRIX_PROMOTE_TERM",
    expectedExit: 143,
    expectedStdout: fixedOutput("==> dumping live database to canonical pre-promote safety net"),
    expectedStderr: fixedOutput(),
  },
  {
    name: "promote psql failure",
    script: "promote-restore.sh",
    child: "psql",
    phase: "admin rename",
    env: { H3_PSQL_FAILURE: "1" },
    fake: "writes stdout/stderr marker, then exits 7",
    marker: "H3_MATRIX_PROMOTE_PSQL",
    expectedExit: 7,
    expectedStdout: fixedOutput(
      "==> checking for live connections",
      "==> promoting restored database",
    ),
    expectedStderr: fixedOutput("promotion failed (psql)"),
  },
  {
    name: "bridge failure",
    script: "promote-restore.sh",
    child: "libpq-service",
    phase: "admin service handoff",
    env: { H3_BRIDGE_FAILURE: "1" },
    fake: "writes stdout/stderr marker, then exits 27",
    marker: "H3_MATRIX_BRIDGE",
    expectedExit: 1,
    expectedStdout: fixedOutput(),
    expectedStderr: fixedOutput("promotion failed (service_handoff)"),
  },
  {
    name: "promote remote restic warnings",
    script: "promote-restore.sh",
    child: "restic",
    phase: "remote backup and retention",
    env: { RESTIC_REPOSITORY: "test:repo", H3_RESTIC_FAILURE: "1" },
    fake: "writes stdout/stderr marker, then exits 8 for backup and forget",
    marker: "H3_MATRIX_PROMOTE_RESTIC",
    expectedExit: 0,
    expectedStdout: fixedOutput(
      "==> checking for live connections",
      "==> dumping live database to canonical pre-promote safety net",
      "==> promoting restored database",
      "==> promote complete; local scratch has been promoted.",
      "canonical pre-promote safety net retention complete (pruned 0)",
    ),
    expectedStderr: fixedOutput(
      "promotion warning: remote safety backup unavailable",
      "promotion warning: remote retention unavailable",
    ),
  },
] as const;

for (const row of hostileRows) {
  test(`hostile matrix: ${row.name}`, () => {
    const f = shellFixture();
    const r = f.run(row.script as "restore-drill.sh" | "restore-pitr.sh" | "promote-restore.sh", {
      ...row.env,
      H3_HOSTILE_CHILD_OUTPUT: "1",
      H3_PGDUMP_SENTINEL: row.marker,
      H3_PSQL_SENTINEL: row.marker,
      H3_RESTIC_SENTINEL: row.marker,
      H3_BRIDGE_SENTINEL: row.marker,
    });
    expect(r.code).toBe(row.expectedExit);
    expect(r.out.replace(/\r\n/g, "\n")).toBe(row.expectedStdout);
    expect(r.err.replace(/\r\n/g, "\n")).toBe(row.expectedStderr);
    expectNoMarker(r, row.marker);
    expectNoPathInterception(r);
    expect(readdirSync(r.scratch)).toEqual([]);
    expectNoConnectionSecrets(r);
  });
}

const hostileSuccessRows = [
  {
    name: "restore-drill success",
    script: "restore-drill.sh",
    extra: {},
    marker: "H3_MATRIX_SUCCESS_DRILL",
    expectedStdout: fixedOutput(
      "==> creating fresh source database dump",
      "==> restoring into private scratch database",
      "==> validating restored database",
      "==> restore drill green",
    ),
    expectedStderr: fixedOutput(),
  },
  {
    name: "restore-pitr success",
    script: "restore-pitr.sh",
    extra: { RESTIC_REPOSITORY: "test:repo" },
    marker: "H3_MATRIX_SUCCESS_PITR",
    expectedStdout: fixedOutput(
      "==> selecting private snapshot",
      "==> restoring selected private snapshot",
      "==> restoring into private scratch database",
      "==> dump replay validation complete",
      "scratch database left in place",
    ),
    expectedStderr: fixedOutput(),
  },
  {
    name: "promote success",
    script: "promote-restore.sh",
    extra: {},
    marker: "H3_MATRIX_SUCCESS_PROMOTE",
    expectedStdout: fixedOutput(
      "==> checking for live connections",
      "==> dumping live database to canonical pre-promote safety net",
      "==> promoting restored database",
      "==> promote complete; local scratch has been promoted.",
      "canonical pre-promote safety net retention complete (pruned 0)",
    ),
    expectedStderr: fixedOutput(),
  },
] as const;
for (const row of hostileSuccessRows) {
  test(`hostile matrix success: ${row.name}`, () => {
    const f = shellFixture();
    const r = f.run(row.script as "restore-drill.sh" | "restore-pitr.sh" | "promote-restore.sh", {
      ...row.extra,
      H3_HOSTILE_CHILD_OUTPUT: "1",
      H3_PGDUMP_SENTINEL: row.marker,
      H3_PSQL_SENTINEL: row.marker,
      H3_RESTIC_SENTINEL: row.marker,
      H3_BRIDGE_SENTINEL: row.marker,
    });
    expect(r.code).toBe(0);
    expect(r.out.replace(/\r\n/g, "\n")).toBe(row.expectedStdout);
    expect(r.err.replace(/\r\n/g, "\n")).toBe(row.expectedStderr);
    expectNoMarker(r, row.marker);
    expectNoPathInterception(r);
    expect(readdirSync(r.scratch)).toEqual([]);
    expectNoConnectionSecrets(r);
  });
}

test.each(["leaf-symlink", "parent-symlink", "multiple", "malformed"] as const)(
  "restic archive %s is rejected before repository inode chmod/read",
  (archiveCase) => {
    for (const script of ["restore-drill.sh", "restore-pitr.sh"] as const) {
      const f = shellFixture();
      const outside = join(f.root, `archive-outside-${archiveCase}`);
      const extra: Record<string, string> = {
        RESTIC_REPOSITORY: "test:repo",
        H3_ARCHIVE_CASE: archiveCase,
        H3_ARCHIVE_OUTSIDE: outside,
        H3_MALFORMED_FIND: join(f.root, "foreign", "malformed-minime.sql"),
      };
      const r = f.run(script, extra);
      expect(r.code).not.toBe(0);
      expect(r.err).toContain(
        `${script === "restore-drill.sh" ? "restore drill" : "restore pitr"} failed (snapshot_dump_missing)`,
      );
      expect(r.out).not.toContain(outside);
      expect(r.err).not.toContain(outside);
      expect(r.trace).not.toContain(outside);
      expectNoPathInterception(r);
      expect(readdirSync(r.scratch)).toEqual([]);
      if (archiveCase === "leaf-symlink") {
        expect(readFileSync(outside, "utf8")).toBe("foreign archive sentinel\n");
        expect(statSync(outside).mode & 0o777).toBe(0o600);
      }
      if (archiveCase === "parent-symlink") expect(existsSync(outside)).toBe(true);
      expectNoConnectionSecrets(r);
    }
  },
);

afterEach(() => {
  for (const root of createdRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("private restore workspaces", () => {
  test("default Homebrew formula Bun/restic candidates resolve through opt-dir symlinks", () => {
    const f = shellFixture();
    const r = f.run("restore-pitr.sh", {
      RESTIC_REPOSITORY: "test:repo",
      H3_FORMULA_RESTIC: "1",
    });
    expect(r.code, r.err).toBe(0);
    expect(r.trace).toContain("command=restic");
    expect(r.trace).toContain("command=restic_restore");
    expect(readdirSync(r.scratch)).toEqual([]);
    expectNoConnectionSecrets(r);
  });

  test("explicit RESTIC_BIN keeps the no-symlink executable-leaf invariant", () => {
    const f = shellFixture();
    const linked = join(f.root, "restic-explicit-link");
    symlinkSync(join(f.trustedBin, "restic"), linked);
    const r = f.run("restore-pitr.sh", {
      RESTIC_REPOSITORY: "test:repo",
      RESTIC_BIN: linked,
      H3_PRESERVE_RESTIC_BIN: "1",
    });
    expect(r.code).not.toBe(0);
    expect(r.err).toBe("restore pitr failed (cleanup_dependency)\n");
    expect(r.trace).not.toContain("command=restic");
    expect(readdirSync(r.scratch)).toEqual([]);
  });

  const signalRows: Array<{
    script: "restore-drill.sh" | "restore-pitr.sh" | "promote-restore.sh";
    label: string;
    extra: Record<string, string>;
  }> = [
    { script: "restore-drill.sh", label: "restore drill", extra: {} },
    { script: "restore-pitr.sh", label: "restore pitr", extra: { RESTIC_REPOSITORY: "test:repo" } },
    { script: "promote-restore.sh", label: "promotion", extra: {} },
  ];

  test.each(["tmp-symlink", "var-symlink"] as const)(
    "canonical TEMP_ROOT signal matrix for %s",
    (tempAlias) => {
      for (const row of signalRows) {
        for (const seam of ["before", "after"] as const) {
          const f = shellFixture({ tempAlias, workspaceSignalHook: "required" });
          const marker = `H3_SIGNAL_${tempAlias}_${row.script}_${seam}_path_credential_SENTINEL`;
          const r = f.run(row.script, {
            ...row.extra,
            [seam === "before" ? "H3_SIGNAL_BEFORE_WORKSPACE" : "H3_SIGNAL_AFTER_WORKSPACE"]: "1",
            H3_HOSTILE_CHILD_OUTPUT: "1",
            H3_PGDUMP_SENTINEL: marker,
            H3_PSQL_SENTINEL: marker,
            H3_RESTIC_SENTINEL: marker,
            H3_BRIDGE_SENTINEL: marker,
          });
          expect(r.code).toBe(143);
          expect(r.out).toBe("");
          expect(r.err).toBe(seam === "before" ? `${row.label} failed (workspace)\n` : "");
          expect(readdirSync(r.tempRoot)).toEqual([]);
          expect(readdirSync(f.scratch)).toEqual([]);
          expect(readdirSync(f.varScratch)).toEqual([]);
          expect(readdirSync(f.tmpAlias)).toEqual([]);
          expect(readdirSync(f.varAlias)).toEqual([]);
          expect(readdirSync(r.foreign)).toEqual([]);
          expect(readdirSync(r.dumpRoot)).toEqual([]);
          expect(existsSync(r.legacyDump)).toBe(false);
          expect(readFileSync(r.cleanupEntryTrace, "utf8").trim().split("\n")).toEqual([
            "cleanup-entry",
          ]);
          expect(readFileSync(r.rmTrace, "utf8").trim().split("\n")).toEqual(
            seam === "before" ? [""] : ["rm"],
          );
          expect(readFixtureFiles(r.root).join("\n")).not.toContain("cleanup_failed");
          expectNoMarker(r, marker);
          expectNoPathInterception(r);
          expectNoConnectionSecrets(r);
        }
      }
    },
  );

  test.each(signalRows)("$script rejects relative TMPDIR before traps/allocation", (row) => {
    const f = shellFixture({ tempAlias: "relative" });
    const r = f.run(row.script, row.extra);
    expect(r.code).not.toBe(0);
    expect(r.err).toBe(`${row.label} failed (workspace)\n`);
    expect(r.out).toBe("");
    expect(readdirSync(f.scratch)).toEqual([]);
    expect(readdirSync(f.varScratch)).toEqual([]);
    expect(readdirSync(f.tmpAlias)).toEqual([]);
    expect(readdirSync(f.varAlias)).toEqual([]);
    expect(readFileSync(r.cleanupEntryTrace, "utf8")).toBe("");
    expect(readFileSync(r.rmTrace, "utf8")).toBe("");
    expectNoPathInterception(r);
    expectNoConnectionSecrets(r);
  });

  test("marker verifier bypasses hostile PATH find and detects a planted regular file", () => {
    const f = shellFixture();
    const marker = "H3_VERIFIER_path_credential_SENTINEL";
    const clean = f.run("restore-drill.sh", {
      H3_UTILITY_SENTINEL: marker,
    });
    expectNoMarker(clean, marker);
    const planted = join(f.root, "verifier-planted-marker");
    writeFileSync(planted, marker, { mode: 0o600 });
    expect(() => expectNoMarker(clean, marker)).toThrow();
  });

  test("baseline fixture mode copies an anchorless script without requiring a signal hook", () => {
    const f = shellFixture({ workspaceSignalHook: "off" });
    const copied = readFileSync(join(f.fixtureScripts, "restore-drill.sh"), "utf8");
    expect(copied).toContain(f.legacyDump);
    expect(copied).not.toContain("/tmp/minime-drill-dump.sql");
    expect(copied).not.toContain("$PGBIN/pg_dump");
  });

  test("signal-hook anchoring accepts only each exact allocation and rejects collisions", () => {
    const valid = [
      ["restore-drill.sh", "WORK_DIR", "minime-private.XXXXXX"],
      ["restore-pitr.sh", "WORK_DIR", "minime-private.XXXXXX"],
      ["promote-restore.sh", "CONNECTION_DIR", "minime-promote-libpq.XXXXXX"],
    ] as const;
    for (const [script, variable, template] of valid) {
      const body = [
        "trap 'exit 143' TERM",
        `if ! ${variable}=\"$($TRUSTED_MKTEMP -d \"$TEMP_ROOT/${template}\" 2>/dev/null)\"; then`,
        "  exit 1",
        "fi",
        'if [ "${H3_SIGNAL_AFTER_WORKSPACE:-0}" = 1 ]; then kill -TERM "$$"; fi',
        `if ! \"$TRUSTED_CHMOD\" 700 \"$${variable}\"; then`,
        "  exit 1",
        "fi",
      ].join("\n");
      const rewritten = injectWorkspaceSignalHook(body, script);
      expect(rewritten.indexOf("H3_SIGNAL_BEFORE_WORKSPACE")).toBeGreaterThan(-1);
      expect(rewritten.indexOf("H3_SIGNAL_AFTER_WORKSPACE")).toBeGreaterThan(-1);
      expect(rewritten.indexOf("H3_SIGNAL_AFTER_WORKSPACE")).toBeLessThan(
        rewritten.indexOf(`if ! \"$TRUSTED_CHMOD\" 700 \"$${variable}\"`),
      );
    }
    const post = 'if [ "${H3_SIGNAL_AFTER_WORKSPACE:-0}" = 1 ]; then kill -TERM "$$"; fi';
    const chmod = 'if ! "$TRUSTED_CHMOD" 700 "$WORK_DIR"; then\n  exit 1\nfi';
    const cases = [
      [
        "missing allocation",
        'WORK_DIR="$($TRUSTED_MKTEMP -d "$TEMP_ROOT/not-the-template.XXXXXX" 2>/dev/null)"',
        post,
      ],
      [
        "duplicate allocation",
        'WORK_DIR="$($TRUSTED_MKTEMP -d "$TEMP_ROOT/minime-private.XXXXXX" 2>/dev/null)"\nWORK_DIR="$($TRUSTED_MKTEMP -d "$TEMP_ROOT/minime-private.XXXXXX" 2>/dev/null)"',
        post,
      ],
      [
        "wrong variable",
        'CONNECTION_DIR="$($TRUSTED_MKTEMP -d "$TEMP_ROOT/minime-private.XXXXXX" 2>/dev/null)"',
        post,
      ],
      [
        "nested later allocation",
        'WORK_DIR="$($TRUSTED_MKTEMP -d "$TEMP_ROOT/minime-private.XXXXXX" 2>/dev/null)"\nif ! "$TRUSTED_MKTEMP" -d "$TEMP_ROOT/another.XXXXXX"; then',
        post,
      ],
      ["lowercase allocation", 'WORK_DIR="$(mktemp -d "$TEMP_ROOT/minime-private.XXXXXX")"', post],
      [
        "missing production post hook",
        'WORK_DIR="$($TRUSTED_MKTEMP -d "$TEMP_ROOT/minime-private.XXXXXX" 2>/dev/null)"',
        "",
      ],
      [
        "duplicate production post hook",
        'WORK_DIR="$($TRUSTED_MKTEMP -d "$TEMP_ROOT/minime-private.XXXXXX" 2>/dev/null)"',
        `${post}\n${post}`,
      ],
      [
        "production post hook before allocation",
        'WORK_DIR="$($TRUSTED_MKTEMP -d "$TEMP_ROOT/minime-private.XXXXXX" 2>/dev/null)"',
        `${post}\n`,
      ],
    ] as const;
    for (const [name, statement, postText] of cases) {
      const body = ["trap 'exit 143' TERM", postText, statement, "  exit 1", "fi", chmod].join(
        "\n",
      );
      expect(() => injectWorkspaceSignalHook(body, "restore-drill.sh"), name).toThrow();
    }
  });

  test("cleanup-entry instrumentation anchors exactly one real cleanup function", () => {
    for (const [script, functionName] of [
      ["restore-drill.sh", "cleanup"],
      ["restore-pitr.sh", "cleanup"],
      ["promote-restore.sh", "cleanup_promote"],
    ] as const) {
      const body = `best_effort_cleanup() {\n}\n${functionName}() {\n  local status=$?\n  return "$status"\n}`;
      const rewritten = injectCleanupEntryTrace(body, script);
      expect(rewritten.match(/cleanup-entry/g)?.length).toBe(1);
      expect(rewritten).toContain("printf '%s\\n' cleanup-entry >> \"$CLEANUP_ENTRY_TRACE\"");
      expect(rewritten.indexOf("best_effort_cleanup() {")).toBeLessThan(
        rewritten.indexOf("cleanup-entry"),
      );
    }
    expect(() => injectCleanupEntryTrace("cleanup_promote() {\n}", "restore-drill.sh")).toThrow();
    expect(() =>
      injectCleanupEntryTrace("cleanup() {\n}\ncleanup() {\n}", "restore-drill.sh"),
    ).toThrow();
    expect(() => injectCleanupEntryTrace("not_cleanup() {\n}", "restore-drill.sh")).toThrow();
    expect(() => injectCleanupEntryTrace("not_cleanup() {\n}", "promote-restore.sh")).toThrow();
    expect(() => injectCleanupEntryTrace("cleanup_extra() {\n}", "restore-drill.sh")).toThrow();
    expect(() => injectCleanupEntryTrace(" cleanup() {\n}", "restore-drill.sh")).toThrow();
    expect(() => injectCleanupEntryTrace("cleanup()  {\n}", "restore-drill.sh")).toThrow();
    expect(() => injectCleanupEntryTrace("cleanup() {\r\n}", "restore-drill.sh")).toThrow();
  });

  test("immutable fake executable roots are excluded, while a runtime marker is detected", () => {
    const f = shellFixture();
    const clean = f.run("restore-drill.sh");
    expectNoPathInterception(clean);
    expect(
      f.immutableRoots.every((directory) => {
        const entry = lstatSync(directory);
        return entry.isDirectory() && !entry.isSymbolicLink();
      }),
    ).toBe(true);
    const planted = join(f.foreign, "runtime-marker.txt");
    writeFileSync(planted, "H3_PATH_INTERCEPT_runtime_path_credential_SENTINEL\n", { mode: 0o600 });
    expect(() => expectNoPathInterception(clean)).toThrow();
  });

  test.each(["intermediate-symlink", "final-symlink", "final-file"] as const)(
    "portable shell preflight rejects %s without child or foreign mutation",
    (kind) => {
      const f = shellFixture();
      const outside = join(f.root, `portable-outside-${kind}`);
      const linkedParent = join(f.fixtureRepo, "portable-linked-parent");
      const dumpRoot = kind === "intermediate-symlink" ? join(linkedParent, "db-dump") : f.dumpRoot;
      const sentinel = join(outside, "sentinel");
      const childMarker = join(f.root, "portable-child-ran");
      mkdirSync(outside, { mode: 0o700 });
      writeFileSync(sentinel, "foreign sentinel\n", { mode: 0o600 });
      if (kind === "intermediate-symlink") symlinkSync(outside, linkedParent, "dir");
      else {
        rmSync(f.dumpRoot, { recursive: true, force: true });
        if (kind === "final-symlink") symlinkSync(outside, f.dumpRoot, "dir");
        else writeFileSync(f.dumpRoot, "foreign collision\n", { mode: 0o600 });
      }
      const preflight = join(f.root, "portable-preflight.sh");
      executable(
        preflight,
        `mode_of() { stat -c "%a" "$1" 2>/dev/null || stat -f "%Lp" "$1"; }
ensure_dump_root() {
  local expected physical mode parent component next
  expected="$EXPECTED_ROOT"
  parent="$(dirname -- "$DUMP_ROOT")"
  component="$parent"
  while :; do
    [ -d "$component" ] || return 1
    [ ! -L "$component" ] || return 1
    next="$(dirname -- "$component" 2>/dev/null)" || return 1
    [ "$next" = "$component" ] && break
    component="$next"
  done
  physical="$(CDPATH= cd -- "$parent" && pwd -P 2>/dev/null)" || return 1
  [ "$physical" = "$parent" ] || return 1
  [ ! -L "$DUMP_ROOT" ] || return 1
  if [ ! -e "$DUMP_ROOT" ]; then
    quiet_utility mkdir -m 700 "$DUMP_ROOT" || return 1
  fi
  [ -d "$DUMP_ROOT" ] || return 1
  physical="$(CDPATH= cd -- "$DUMP_ROOT" && pwd -P 2>/dev/null)" || return 1
  [ "$physical" = "$expected" ] || return 1
  mode="$(mode_of "$DUMP_ROOT")"
  [ "$mode" = 700 ] || return 1
}
if ! ensure_dump_root; then
  echo "promotion failed (private_dump_root)" >&2
  exit 1
fi
printf '%s' ran > "$CHILD_MARKER"`,
      );
      const r = Bun.spawnSync(["/bin/bash", preflight], {
        env: {
          ...process.env,
          DUMP_ROOT: dumpRoot,
          EXPECTED_ROOT: join(f.fixtureRepo, "portable-expected", "db-dump"),
          CHILD_MARKER: childMarker,
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(r.exitCode).toBe(1);
      expect(r.stderr.toString()).toBe("promotion failed (private_dump_root)\n");
      expect(existsSync(childMarker)).toBe(false);
      expect(existsSync(join(outside, "db-dump"))).toBe(false);
      expect(readFileSync(sentinel, "utf8")).toBe("foreign sentinel\n");
      expect(statSync(sentinel).mode & 0o777).toBe(0o600);
      if (kind === "final-symlink") expect(lstatSync(f.dumpRoot).isSymbolicLink()).toBe(true);
      if (kind === "final-file")
        expect(readFileSync(f.dumpRoot, "utf8")).toBe("foreign collision\n");
    },
  );

  test.each([
    ["restore-drill.sh", "restore drill failed (workspace)"],
    ["restore-pitr.sh", "restore pitr failed (workspace)"],
    ["promote-restore.sh", "promotion failed (workspace)"],
  ] as const)("%s installs cleanup before its first workspace allocation", (script, diagnostic) => {
    const f = shellFixture({ workspaceSignalHook: "required" });
    const foreignSentinel = join(f.foreign, "sentinel");
    writeFileSync(foreignSentinel, "foreign sentinel\n", { mode: 0o600 });
    const r = f.run(script, { H3_SIGNAL_BEFORE_WORKSPACE: "1" });
    expect(r.code).toBe(143);
    expect(r.err).toBe(`${diagnostic}\n`);
    expect(readdirSync(r.scratch)).toEqual([]);
    expect(readFileSync(foreignSentinel, "utf8")).toBe("foreign sentinel\n");
    expect(statSync(foreignSentinel).mode & 0o777).toBe(0o600);
    expectNoConnectionSecrets(r);
  });

  test("restore-drill fresh-dump success uses private modes and cleans every artifact", () => {
    const f = shellFixture();
    const r = f.run("restore-drill.sh");
    expect(r.code, r.err).toBe(0);
    expect(r.trace).toMatch(/command=pg_dump mode_before=600 service_mode=600/);
    expect(r.trace.match(/psql_service_mode=600/g)?.length ?? 0).toBeGreaterThan(0);
    expect(readdirSync(r.scratch)).toEqual([]);
    expect(existsSync(r.legacyDump)).toBe(false);
    expect(existsSync(join(r.foreign, "db-dump"))).toBe(false);
    expectNoConnectionSecrets(r);
  });

  test.each(["symlink", "directory", "regular"] as const)(
    "restore-drill rejects a pg_dump %s replacement before replay",
    (replacement) => {
      const f = shellFixture();
      const foreign = join(f.foreign, `pg-dump-${replacement}.sql`);
      writeFileSync(foreign, "-- foreign target --\n", { mode: 0o600 });
      const r = f.run("restore-drill.sh", {
        H3_PGDUMP_REPLACE: replacement,
        H3_PGDUMP_FOREIGN: foreign,
      });
      expect(r.code).not.toBe(0);
      expect(r.err).toBe("restore drill failed (pg_dump_output)\n");
      expect(r.trace.lastIndexOf("command=psql")).toBeLessThan(r.trace.indexOf("command=pg_dump"));
      expect(readFileSync(foreign, "utf8")).toBe("-- foreign target --\n");
      expect(readdirSync(r.scratch)).toEqual([]);
      expectNoConnectionSecrets(r);
    },
  );

  test.each(["symlink", "directory", "regular"] as const)(
    "promote rejects a pg_dump %s replacement before publishing or retention",
    (replacement) => {
      const f = shellFixture();
      const foreign = join(f.foreign, `promote-${replacement}.sql`);
      writeFileSync(foreign, "-- foreign target --\n", { mode: 0o600 });
      const prior = join(f.dumpRoot, "minime-pre-promote-prior-good");
      writeFileSync(prior, "-- prior good dump --\n", { mode: 0o600 });
      const r = f.run("promote-restore.sh", {
        H3_PGDUMP_REPLACE: replacement,
        H3_PGDUMP_FOREIGN: foreign,
      });
      expect(r.code).not.toBe(0);
      expect(r.err).toBe("promotion failed (pg_dump_output)\n");
      expect(r.trace.lastIndexOf("command=psql")).toBeLessThan(r.trace.indexOf("command=pg_dump"));
      expect(r.trace).not.toContain("command=restic");
      expect(readFileSync(foreign, "utf8")).toBe("-- foreign target --\n");
      expect(readFileSync(prior, "utf8")).toBe("-- prior good dump --\n");
      expect(
        readdirSync(f.dumpRoot).filter((name) => name.startsWith("minime-pre-promote-")),
      ).toHaveLength(2);
      expect(readdirSync(r.scratch)).toEqual([]);
      expectNoConnectionSecrets(r);
    },
  );

  test.each(["restore-drill.sh", "restore-pitr.sh", "promote-restore.sh"] as const)(
    "%s disables inherited xtrace before secrets and keeps normal behavior",
    (script) => {
      const f = shellFixture({ xtrace: true });
      const r = f.run(
        script,
        script === "restore-pitr.sh" ? { RESTIC_REPOSITORY: "test:repo" } : {},
      );
      expect(r.code, r.err).toBe(0);
      expectNoConnectionSecrets(r);
      expect(r.trace).not.toContain("credential-sentinel");
      expect(r.err).not.toContain("credential-sentinel");
      expect(r.out).not.toContain("credential-sentinel");
    },
  );

  test.each([
    ["restore-drill.sh", "restore drill failed (service_handoff)"],
    ["restore-pitr.sh", "restore pitr failed (service_handoff)"],
    ["promote-restore.sh", "promotion failed (service_handoff)"],
  ] as const)("%s maps hostile libpq bridge failure to a fixed code", (script, message) => {
    const f = shellFixture();
    const marker = `H3_BRIDGE_${script}_credential_SENTINEL`;
    const r = f.run(script, { H3_BRIDGE_FAILURE: "1", H3_BRIDGE_SENTINEL: marker });
    expect(r.code).not.toBe(0);
    expect(r.err).toContain(message);
    expectNoMarker(r, marker);
    expect(readdirSync(r.scratch)).toEqual([]);
    expectNoConnectionSecrets(r);
  });

  test.each(["restore-drill.sh", "restore-pitr.sh", "promote-restore.sh"] as const)(
    "%s cleans a bridge temp when SIGTERM arrives immediately after registration",
    (script) => {
      const f = shellFixture();
      const sentinel = join(f.foreign, "bridge-sentinel");
      writeFileSync(sentinel, "foreign sentinel\n", { mode: 0o600 });
      const r = f.run(script, { H3_SIGNAL_AFTER_BRIDGE_REGISTER: "1" });
      expect(r.code).not.toBe(0);
      expect(r.err).toContain("service_handoff");
      expect(readdirSync(r.scratch)).toEqual([]);
      expect(readFileSync(sentinel, "utf8")).toBe("foreign sentinel\n");
      expect(statSync(sentinel).mode & 0o777).toBe(0o600);
      expectNoConnectionSecrets(r);
    },
  );

  test.each([
    ["restore-drill.sh", {}, "H3_PGDUMP_HOSTILE", 0],
    ["restore-pitr.sh", { RESTIC_REPOSITORY: "test:repo" }, "H3_RESTIC_HOSTILE", 0],
    ["promote-restore.sh", {}, "H3_PGDUMP_HOSTILE", 0],
  ] as const)("%s suppresses hostile child output on success", (script, extra, marker) => {
    const f = shellFixture();
    const r = f.run(script, {
      ...extra,
      H3_HOSTILE_CHILD_OUTPUT: "1",
      H3_PGDUMP_SENTINEL: marker,
      H3_PSQL_SENTINEL: marker,
      H3_RESTIC_SENTINEL: marker,
    });
    expect(r.code).toBe(0);
    expectNoMarker(r, marker);
    expectNoConnectionSecrets(r);
  });

  test.each([
    ["restore-drill.sh", { H3_VALIDATE_FAILURE: "1" }, "H3_DRILL_PSQL_HOSTILE"],
    [
      "restore-drill.sh",
      { RESTIC_REPOSITORY: "test:repo", H3_RESTIC_FAILURE: "1" },
      "H3_DRILL_RESTIC_HOSTILE",
    ],
    [
      "restore-pitr.sh",
      { RESTIC_REPOSITORY: "test:repo", H3_RESTIC_FAILURE: "1" },
      "H3_PITR_RESTIC_HOSTILE",
    ],
    [
      "restore-pitr.sh",
      { RESTIC_REPOSITORY: "test:repo", H3_REPLAY_ERRORS: "1" },
      "H3_PITR_PSQL_HOSTILE",
    ],
    ["promote-restore.sh", { H3_PGDUMP_FAILURE: "1" }, "H3_PROMOTE_PGDUMP_HOSTILE"],
    ["promote-restore.sh", { H3_PSQL_FAILURE: "1" }, "H3_PROMOTE_PSQL_HOSTILE"],
  ] as const)("%s suppresses hostile child output on failure", (script, extra, marker) => {
    const f = shellFixture();
    const r = f.run(script, {
      ...extra,
      H3_HOSTILE_CHILD_OUTPUT: "1",
      H3_PGDUMP_SENTINEL: marker,
      H3_PSQL_SENTINEL: marker,
      H3_RESTIC_SENTINEL: marker,
    });
    expect(r.code).not.toBe(0);
    expectNoMarker(r, marker);
    expectNoConnectionSecrets(r);
  });

  test("restore-drill injected psql failure still cleans every artifact", () => {
    const f = shellFixture();
    const r = f.run("restore-drill.sh", { H3_REPLAY_ERRORS: "1" });
    expect(r.code).not.toBe(0);
    expect(r.trace.match(/psql_service_mode=600/g)?.length ?? 0).toBeGreaterThan(0);
    expect(readdirSync(r.scratch)).toEqual([]);
    expectNoConnectionSecrets(r);
  });

  test("restore-drill rejects an unrepresentable source URI before pg_dump and cleans", () => {
    const f = shellFixture();
    const r = f.run("restore-drill.sh", {
      DATABASE_URL: "postgres://user:bad%0Ahost=remote@localhost/minime_test",
    });
    expect(r.code).not.toBe(0);
    expect(r.trace).not.toContain("pg_dump_file=");
    expect(r.err).not.toContain("bad%0A");
    expect(readdirSync(r.scratch)).toEqual([]);
  });

  test("restore-drill restic failure cleans the extraction workspace", () => {
    const f = shellFixture();
    const r = f.run("restore-drill.sh", {
      RESTIC_REPOSITORY: "test:repo",
      H3_RESTIC_FAILURE: "1",
    });
    expect(r.code).not.toBe(0);
    expect(readdirSync(r.scratch)).toEqual([]);
  });

  test("restore-drill validation failure cleans dump and workspace", () => {
    const f = shellFixture();
    const r = f.run("restore-drill.sh", { H3_VALIDATE_FAILURE: "1" });
    expect(r.code).toBe(9);
    expect(readdirSync(r.scratch)).toEqual([]);
  });

  test("restore-drill TERM exits 143 and its EXIT trap removes the workspace", () => {
    const f = shellFixture();
    const r = f.run("restore-drill.sh", { H3_SIGNAL_PARENT: "1" });
    expect(r.code).toBe(143);
    expect(readdirSync(r.scratch)).toEqual([]);
  });

  test("restore-drill restic success cleans the private extraction target", () => {
    const f = shellFixture();
    const r = f.run("restore-drill.sh", { RESTIC_REPOSITORY: "test:repo" });
    expect(r.code, r.err).toBe(0);
    expect(r.trace).toMatch(/command=restic_restore mode=700 dump_mode=600/);
    expect(readdirSync(r.scratch)).toEqual([]);
  });

  test("restore-pitr success keeps the scratch database but no plaintext files", () => {
    const f = shellFixture();
    const r = f.run("restore-pitr.sh", { RESTIC_REPOSITORY: "test:repo" });
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain("scratch database left in place");
    expect(r.out).not.toContain("minime_restore");
    expect(r.trace).toMatch(/command=restic_restore mode=700 dump_mode=600/);
    expect(r.trace).toContain("psql_service_mode=600");
    expect(readdirSync(r.scratch)).toEqual([]);
    const source = readFileSync(join(r.fixtureRepo, "scripts", "restore-pitr.sh"), "utf8");
    const handoff = source.slice(source.lastIndexOf("cat <<EOF"));
    expect(handoff).not.toContain("$LIVE_URL");
    expect(handoff).not.toContain("$RESTORE_URL");
    expectNoConnectionSecrets(r);
  });

  test("restore-pitr SQL replay errors fail closed through ON_ERROR_STOP", () => {
    const f = shellFixture();
    const r = f.run("restore-pitr.sh", {
      RESTIC_REPOSITORY: "test:repo",
      H3_REPLAY_ERRORS: "1",
    });
    expect(r.code).toBe(4);
    expect(r.err).toContain("restore validation failed; promotion refused");
    expect(r.err).not.toContain("MUST NOT be promoted");
    expect(r.trace).toContain("replay_stderr_mode=600");
    expect(readdirSync(r.scratch)).toEqual([]);
    expectNoConnectionSecrets(r);
  });

  test("pre-promote dump and retention stay inside the fixture repository", () => {
    const f = shellFixture();
    const nonMatching = join(f.dumpRoot, "not-a-pre-promote-dump");
    writeFileSync(nonMatching, "foreign nonmatching sentinel\n", { mode: 0o600 });
    for (let index = 0; index < 7; index += 1) {
      const file = join(f.dumpRoot, `minime-pre-promote-20260701-00000${index}`);
      writeFileSync(file, `-- old safety dump sentinel ${index} --\n`, { mode: 0o600 });
      const when = new Date(Date.UTC(2026, 6, 1, 0, 0, 0));
      utimesSync(file, when, when);
    }
    const oldNames = readdirSync(f.dumpRoot).filter((name) =>
      name.startsWith("minime-pre-promote-"),
    );
    const hostileMarker = "H3_RETENTION_PATH_RM_SENTINEL";
    const r = f.run("promote-restore.sh", {
      H3_UTILITY_SENTINEL: hostileMarker,
    });
    expect(r.code, r.err).toBe(0);
    const kept = readdirSync(f.dumpRoot).filter((name) => name.startsWith("minime-pre-promote-"));
    expect(kept).toHaveLength(5);
    expect(readFileSync(nonMatching, "utf8")).toBe("foreign nonmatching sentinel\n");
    expect(kept.some((name) => name.includes("20260701-000000"))).toBe(false);
    expect(kept.some((name) => name.includes("20260701-000001"))).toBe(false);
    expect(kept.some((name) => name.includes("20260701-000002"))).toBe(false);
    expect(kept.filter((name) => name.startsWith("minime-pre-promote-20260701-")).sort()).toEqual([
      "minime-pre-promote-20260701-000003",
      "minime-pre-promote-20260701-000004",
      "minime-pre-promote-20260701-000005",
      "minime-pre-promote-20260701-000006",
    ]);
    expect(r.out).toContain("canonical pre-promote safety net retention complete (pruned 3)\n");
    expectNoMarker(r, hostileMarker);
    expect(r.trace).toMatch(/command=pg_dump mode_before=600 service_mode=600/);
    expect(r.trace).toMatch(/psql_service_mode=600/);
    expectNoConnectionSecrets(r);
    expect(statSync(f.dumpRoot).mode & 0o777).toBe(0o700);
    expect(kept.every((name) => (statSync(join(f.dumpRoot, name)).mode & 0o777) === 0o600)).toBe(
      true,
    );
    expect(existsSync(join(r.foreign, "db-dump"))).toBe(false);
    expect(readdirSync(r.scratch)).toEqual([]);
  });

  test("retention cleanup failure keeps the completed dump and never leaks paths", () => {
    const f = shellFixture();
    const foreign = join(f.root, "retention-foreign");
    mkdirSync(foreign, { mode: 0o700 });
    const foreignSentinel = join(foreign, "sentinel");
    writeFileSync(foreignSentinel, "foreign sentinel\n", { mode: 0o600 });
    for (let index = 0; index < 7; index += 1) {
      const file = join(f.dumpRoot, `minime-pre-promote-20260701-00000${index}`);
      writeFileSync(file, `-- old safety dump sentinel ${index} --\n`, { mode: 0o600 });
      const when = new Date(Date.UTC(2026, 6, 1, 0, 0, 0));
      utimesSync(file, when, when);
    }
    const oldNames = readdirSync(f.dumpRoot).filter((name) =>
      name.startsWith("minime-pre-promote-"),
    );
    const r = f.run("promote-restore.sh", {
      H3_TRUSTED_RM_TEST_MODE: "persistent",
      H3_UTILITY_SENTINEL: "H3_RETENTION_RM_path_credential_SENTINEL",
    });
    expect(r.code).toBe(1);
    expect(r.err).toBe("promotion failed (retention_cleanup)\n");
    expect(r.out).not.toContain("retention-foreign");
    expectNoMarker(r, "H3_RETENTION_RM_path_credential_SENTINEL");
    expect(readFileSync(foreignSentinel, "utf8")).toBe("foreign sentinel\n");
    expect(statSync(foreignSentinel).mode & 0o777).toBe(0o600);
    expect(oldNames.every((name) => existsSync(join(f.dumpRoot, name)))).toBe(true);
    expect(r.out).not.toContain("pruned");
    expect(readdirSync(r.scratch).length).toBeGreaterThan(0);
    expectNoConnectionSecrets(r);
    // The harness removes this private retained workspace in afterEach; production reports
    // cleanup_failed and leaves only the validated owned artifact for owner recovery.
  });

  test("trusted cleanup retry hides a transient removal failure and leaves no artifacts", () => {
    const f = shellFixture();
    const marker = "H3_TRANSIENT_TRUSTED_RM_path_credential_SENTINEL";
    const r = f.run("restore-drill.sh", {
      H3_TRUSTED_RM_TEST_MODE: "transient",
      H3_UTILITY_SENTINEL: marker,
    });
    expect(r.code).toBe(0);
    expect(r.err).toBe("");
    expectNoMarker(r, marker);
    expect(readdirSync(r.scratch)).toEqual([]);
    expectNoConnectionSecrets(r);
  });

  test("promote rejects an intermediate symlink parent before child commands", () => {
    const f = shellFixture();
    const outside = join(f.root, "outside-parent");
    const linkedParent = join(f.fixtureRepo, "linked-parent");
    const scriptPath = join(f.fixtureScripts, "promote-restore.sh");
    mkdirSync(outside, { mode: 0o700 });
    const sentinel = join(outside, "sentinel");
    writeFileSync(sentinel, "foreign sentinel\n", { mode: 0o600 });
    symlinkSync(outside, linkedParent, "dir");
    const rewritten = readFileSync(scriptPath, "utf8").replace(
      'DUMP_ROOT="$REPO_ROOT/db-dump"',
      'DUMP_ROOT="$REPO_ROOT/linked-parent/db-dump"',
    );
    writeFileSync(scriptPath, rewritten, { mode: 0o700 });
    chmodSync(scriptPath, 0o700);
    const r = f.run("promote-restore.sh");
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("promotion failed (private_dump_root)");
    expect(r.trace).not.toContain("pg_dump_file=");
    expect(existsSync(join(outside, "db-dump"))).toBe(false);
    expect(readFileSync(sentinel, "utf8")).toBe("foreign sentinel\n");
    expect(statSync(sentinel).mode & 0o777).toBe(0o600);
    expect(readdirSync(r.scratch)).toEqual([]);
  });

  test.each(["symlink", "file"] as const)(
    "promote rejects a final %s dump-root collision before child commands",
    (kind) => {
      const f = shellFixture();
      const outside = join(f.root, `outside-final-${kind}`);
      mkdirSync(outside, { mode: 0o700 });
      const sentinel = join(outside, "sentinel");
      writeFileSync(sentinel, "foreign sentinel\n", { mode: 0o600 });
      rmSync(f.dumpRoot, { recursive: true, force: true });
      if (kind === "symlink") symlinkSync(outside, f.dumpRoot, "dir");
      else writeFileSync(f.dumpRoot, "foreign collision\n", { mode: 0o600 });
      const r = f.run("promote-restore.sh");
      expect(r.code).not.toBe(0);
      expect(r.err).toContain("promotion failed (private_dump_root)");
      expect(r.trace).not.toContain("pg_dump_file=");
      expect(readFileSync(sentinel, "utf8")).toBe("foreign sentinel\n");
      expect(statSync(sentinel).mode & 0o777).toBe(0o600);
      expect(readdirSync(r.scratch)).toEqual([]);
      if (kind === "symlink") expect(lstatSync(f.dumpRoot).isSymbolicLink()).toBe(true);
      else expect(readFileSync(f.dumpRoot, "utf8")).toBe("foreign collision\n");
    },
  );

  test("failed pre-promote pg_dump removes its service workspace and incomplete dump", () => {
    const f = shellFixture();
    const r = f.run("promote-restore.sh", { H3_PGDUMP_FAILURE: "1" });
    expect(r.code).toBe(13);
    expect(readdirSync(r.scratch)).toEqual([]);
    expect(
      readdirSync(f.dumpRoot).filter((name) => name.startsWith("minime-pre-promote-")),
    ).toEqual([]);
  });

  test("TERM during pre-promote pg_dump removes only the incomplete safety dump", () => {
    const f = shellFixture();
    const completed = join(f.dumpRoot, "minime-pre-promote-completed");
    writeFileSync(completed, "-- fictional completed safety dump --\n", { mode: 0o600 });
    const r = f.run("promote-restore.sh", { H3_SIGNAL_PARENT: "1" });
    expect(r.code).toBe(143);
    expect(readdirSync(r.scratch)).toEqual([]);
    expect(readFileSync(completed, "utf8")).toContain("completed safety dump");
    expect(
      readdirSync(f.dumpRoot).filter(
        (name) => name.startsWith("minime-pre-promote-") && name !== "minime-pre-promote-completed",
      ),
    ).toEqual([]);
  });

  test("successful pre-promote pg_dump that signals parent preserves completed dump", () => {
    const f = shellFixture();
    const r = f.run("promote-restore.sh", { H3_PGDUMP_SIGNAL_SUCCESS: "1" });
    expect(r.code).toBe(143);
    expect(readdirSync(r.scratch)).toEqual([]);
    const dumps = readdirSync(f.dumpRoot).filter((name) => name.startsWith("minime-pre-promote-"));
    expect(dumps).toHaveLength(1);
    expect(readFileSync(join(f.dumpRoot, dumps[0]!), "utf8")).toContain(
      "COPY public.schema_migrations",
    );
  });

  test.each(["restore-drill.sh", "restore-pitr.sh", "promote-restore.sh"] as const)(
    "credential URL variables are cleared before every child for %s",
    (script) => {
      const f = shellFixture();
      const r = f.run(script, {
        H3_ENV_GUARD: "1",
        H3_AUTO_EXPORT: "1",
        raw: "postgres://h3-source-user:credential-sentinel@localhost:5432/minime_test",
        ...(script === "restore-pitr.sh" ? { RESTIC_REPOSITORY: "test:repo" } : {}),
      });
      expect(r.code, r.err).toBe(0);
      expectNoConnectionSecrets(r);
      expect(r.out).not.toContain("H3_ENV_URL_LEAK");
      expect(r.err).not.toContain("H3_ENV_URL_LEAK");
      expect(r.trace).not.toContain("H3_ENV_URL_LEAK");
    },
  );

  test.each(["restore-drill.sh", "restore-pitr.sh", "promote-restore.sh"] as const)(
    "caller-preexported raw is cleared before Bun for %s",
    (script) => {
      const f = shellFixture();
      const r = f.run(script, {
        H3_ENV_GUARD: "1",
        raw: "postgres://h3-source-user:credential-sentinel@localhost:5432/minime_test",
        ...(script === "restore-pitr.sh" ? { RESTIC_REPOSITORY: "test:repo" } : {}),
      });
      expect(r.code, r.err).toBe(0);
      expectNoConnectionSecrets(r);
      expect(r.out).not.toContain("H3_ENV_URL_LEAK");
      expect(r.err).not.toContain("H3_ENV_URL_LEAK");
      expect(r.trace).not.toContain("H3_ENV_URL_LEAK");
    },
  );

  test("retention rejects malicious direct entries before pruning any safety dump", () => {
    const f = shellFixture();
    const validNames: string[] = [];
    for (let index = 0; index < 7; index += 1) {
      const name = `minime-pre-promote-20260701-00000${index}`;
      validNames.push(name);
      writeFileSync(join(f.dumpRoot, name), `-- valid safety dump ${index} --\n`, { mode: 0o600 });
    }
    const maliciousBasename = join(f.dumpRoot, "minime-pre-promote-..");
    const newlineName = join(f.dumpRoot, "minime-pre-promote-newline\n-injected");
    writeFileSync(maliciousBasename, "malicious basename sentinel\n", { mode: 0o600 });
    writeFileSync(newlineName, "newline basename sentinel\n", { mode: 0o600 });
    const outside = join(f.root, "retention-adversarial-outside");
    mkdirSync(outside, { mode: 0o700 });
    const foreignSentinel = join(outside, "sentinel");
    writeFileSync(foreignSentinel, "foreign retention sentinel\n", { mode: 0o600 });
    symlinkSync(outside, join(f.dumpRoot, "minime-pre-promote-symlink-parent"), "dir");
    mkdirSync(join(f.dumpRoot, "minime-pre-promote-nested"), { mode: 0o700 });
    writeFileSync(
      join(f.dumpRoot, "minime-pre-promote-nested", "nested.dump"),
      "nested sentinel\n",
      { mode: 0o600 },
    );
    const r = f.run("promote-restore.sh", { H3_TRUSTED_RM_TEST_MODE: "persistent" });
    expect(r.code).toBe(1);
    expect(r.err).toBe("promotion failed (retention)\n");
    expect(validNames.every((name) => existsSync(join(f.dumpRoot, name)))).toBe(true);
    expect(readFileSync(maliciousBasename, "utf8")).toBe("malicious basename sentinel\n");
    expect(readFileSync(newlineName, "utf8")).toBe("newline basename sentinel\n");
    expect(readFileSync(foreignSentinel, "utf8")).toBe("foreign retention sentinel\n");
    expect(existsSync(join(f.dumpRoot, "minime-pre-promote-nested", "nested.dump"))).toBe(true);
    expect(r.out).not.toContain("pruned");
    expect(r.out).not.toContain(foreignSentinel);
    expectNoConnectionSecrets(r);
  });

  test.each(["symlink", "directory"] as const)(
    "retention rejects a matching direct-child %s before pruning",
    (kind) => {
      const f = shellFixture();
      const validNames: string[] = [];
      for (let index = 0; index < 7; index += 1) {
        const name = `minime-pre-promote-20260701-00000${index}`;
        validNames.push(name);
        writeFileSync(join(f.dumpRoot, name), `-- valid safety dump ${index} --\n`, {
          mode: 0o600,
        });
      }
      const matching = join(f.dumpRoot, `minime-pre-promote-${kind}`);
      const outside = join(f.root, `retention-${kind}-outside`);
      mkdirSync(outside, { mode: 0o700 });
      const foreignSentinel = join(outside, "sentinel");
      writeFileSync(foreignSentinel, "foreign retention sentinel\n", { mode: 0o600 });
      let matchingSentinel = "";
      if (kind === "symlink") symlinkSync(outside, matching, "dir");
      else {
        mkdirSync(matching, { mode: 0o700 });
        matchingSentinel = join(matching, "sentinel");
        writeFileSync(matchingSentinel, "matching directory sentinel\n", { mode: 0o600 });
      }
      const foreignModeBefore = statSync(foreignSentinel).mode & 0o777;
      const matchingModeBefore = kind === "directory" ? statSync(matching).mode & 0o777 : 0;
      const r = f.run("promote-restore.sh", { H3_TRUSTED_RM_TEST_MODE: "persistent" });
      expect(r.code).toBe(1);
      expect(r.err).toBe("promotion failed (retention)\n");
      expect(validNames.every((name) => existsSync(join(f.dumpRoot, name)))).toBe(true);
      expect(readFileSync(foreignSentinel, "utf8")).toBe("foreign retention sentinel\n");
      expect(statSync(foreignSentinel).mode & 0o777).toBe(foreignModeBefore);
      expect(readFileSync(matchingSentinel || foreignSentinel, "utf8")).toBe(
        matchingSentinel ? "matching directory sentinel\n" : "foreign retention sentinel\n",
      );
      expect(statSync(matchingSentinel || foreignSentinel).mode & 0o777).toBe(
        matchingSentinel ? 0o600 : foreignModeBefore,
      );
      if (kind === "symlink") expect(lstatSync(matching).isSymbolicLink()).toBe(true);
      else {
        expect(lstatSync(matching).isDirectory()).toBe(true);
        expect(statSync(matching).mode & 0o777).toBe(matchingModeBefore);
      }
      expect(readFileSync(r.rmTrace, "utf8")).toBe("");
      expect(r.out).not.toContain("pruned");
      expect(r.out).not.toContain("retention complete");
      expectNoConnectionSecrets(r);
    },
  );
});

const resolverProbe = `
set -euf
RESOLVED_BINARY=""
resolve_trusted_binary() {
  local candidate="$1" parent physical
  RESOLVED_BINARY=""
  [ "\${candidate#/}" != "$candidate" ] || return 1
  [ -f "$candidate" ] && [ -x "$candidate" ] && [ ! -L "$candidate" ] || return 1
  parent="\${candidate%/*}"
  physical="$(CDPATH= cd -- "$parent" 2>/dev/null && pwd -P)" || return 1
  [ "$physical/\${candidate##*/}" = "$candidate" ] || return 1
  RESOLVED_BINARY="$candidate"
}
if [ -n "\${H3_REALPATH_SHIM:-}" ]; then
  case "\${H3_REALPATH_PLATFORM:-}" in darwin|gnu) ;; *) exit 3 ;; esac
  [ "$("$H3_REALPATH_SHIM" "$CANDIDATE")" = "$CANDIDATE" ] || exit 2
fi
resolve_trusted_binary "$CANDIDATE" || true
printf '%s' "$RESOLVED_BINARY"
`;
const resolverNames = [
  "space name",
  "quote'file\"name",
  "literal-$(touch SHOULD_NOT_EXIST)",
  "semi;colon",
  "line\nbreak",
];
test.each(resolverNames)(
  "accepts a safe absolute executable named %j without evaluation",
  (name) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "minime-h3-resolver-")));
    const marker = join(root, "SHOULD_NOT_EXIST");
    const candidate = join(root, name);
    writeFileSync(candidate, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    chmodSync(candidate, 0o700);
    const r = Bun.spawnSync(["/bin/bash", "-c", resolverProbe], {
      cwd: root,
      env: { ...process.env, CANDIDATE: candidate },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.toString()).toBe(candidate);
    expect(existsSync(marker)).toBe(false);
    rmSync(root, { recursive: true, force: true });
  },
);
test("rejected resolver candidate leaves RESOLVED_BINARY empty and emits no path", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "minime-h3-resolver-reject-")));
  const foreign = join(root, "foreign");
  const candidate = join(root, "not-executable;$(touch SHOULD_NOT_EXIST)");
  writeFileSync(candidate, "not executable\n", { mode: 0o600 });
  symlinkSync(foreign, join(root, "symlink-candidate"));
  const r = Bun.spawnSync(["/bin/bash", "-c", resolverProbe], {
    cwd: root,
    env: { ...process.env, CANDIDATE: candidate },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(r.stdout.toString()).toBe("");
  expect(r.stderr.toString()).toBe("");
  expect(readFileSync(candidate, "utf8")).toBe("not executable\n");
  expect(readFileSync(join(root, "not-executable;$(touch SHOULD_NOT_EXIST)"), "utf8")).toBe(
    "not executable\n",
  );
  const symlinkResult = Bun.spawnSync(["/bin/bash", "-c", resolverProbe], {
    cwd: root,
    env: { ...process.env, CANDIDATE: join(root, "symlink-candidate") },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(symlinkResult.stdout.toString()).toBe("");
  expect(symlinkResult.stderr.toString()).toBe("");
  const physicalDir = join(root, "physical-dir");
  const linkedDir = join(root, "linked-dir");
  mkdirSync(physicalDir, { mode: 0o700 });
  writeFileSync(join(physicalDir, "candidate"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  symlinkSync(physicalDir, linkedDir, "dir");
  const linkedParent = Bun.spawnSync(["/bin/bash", "-c", resolverProbe], {
    cwd: root,
    env: { ...process.env, CANDIDATE: join(linkedDir, "candidate") },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(linkedParent.stdout.toString()).toBe("");
  expect(linkedParent.stderr.toString()).toBe("");
  rmSync(root, { recursive: true, force: true });
});
test.each(["darwin", "gnu"] as const)(
  "resolver stays portable when %s realpath rejects -P",
  (platform) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "minime-h3-realpath-platform-")));
    const candidate = join(root, "candidate");
    const shim = join(root, "realpath-shim");
    writeFileSync(candidate, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    chmodSync(candidate, 0o700);
    executable(shim, `if [ "\${1:-}" = -P ]; then exit 64; fi\nprintf '%s\\n' "$1"`);
    const unsupported = Bun.spawnSync([shim, "-P", candidate], { stdout: "pipe", stderr: "pipe" });
    expect(unsupported.exitCode).toBe(64);
    const r = Bun.spawnSync(["/bin/bash", "-c", resolverProbe], {
      cwd: root,
      env: {
        ...process.env,
        CANDIDATE: candidate,
        H3_REALPATH_PLATFORM: platform,
        H3_REALPATH_SHIM: shim,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.toString()).toBe(candidate);
    expect(r.stderr.toString()).toBe("");
    rmSync(root, { recursive: true, force: true });
  },
);
test("Homebrew opt-dir symlinks are physicalized while executable leaves stay regular", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "minime-h3-homebrew-opt-")));
  const cellar = join(root, "Cellar", "bun", "1.2.3", "bin");
  const opt = join(root, "opt", "bun");
  mkdirSync(cellar, { recursive: true, mode: 0o700 });
  mkdirSync(join(root, "opt"), { mode: 0o700 });
  symlinkSync(join(root, "Cellar", "bun", "1.2.3"), opt, "dir");
  const executableLeaf = join(cellar, "bun");
  writeFileSync(executableLeaf, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  chmodSync(executableLeaf, 0o700);
  const probe = `
set -euf
PHYSICAL_BIN_DIR=""
physicalize_bin_dir() {
  local candidate="$1"
  PHYSICAL_BIN_DIR=""
  case "$candidate" in /*) ;; *) return 1 ;; esac
  [ -d "$candidate" ] || return 1
  PHYSICAL_BIN_DIR="$(CDPATH= cd -- "$candidate" 2>/dev/null && pwd -P)" || return 1
  [ -d "$PHYSICAL_BIN_DIR" ] && [ ! -L "$PHYSICAL_BIN_DIR" ] || return 1
}
resolve_trusted_binary() {
  local candidate="$1" parent physical
  [ -f "$candidate" ] && [ -x "$candidate" ] && [ ! -L "$candidate" ] || return 1
  parent="\${candidate%/*}"
  physical="$(CDPATH= cd -- "$parent" 2>/dev/null && pwd -P)" || return 1
  [ "$physical/\${candidate##*/}" = "$candidate" ] || return 1
  printf '%s' "$candidate"
}
physicalize_bin_dir "$OPT_DIR"
TARGET_LEAF="\${TARGET_LEAF:-$PHYSICAL_BIN_DIR/bun}"
resolve_trusted_binary "$TARGET_LEAF"
`;
  const r = Bun.spawnSync(["/bin/bash", "-c", probe], {
    cwd: root,
    env: { ...process.env, OPT_DIR: join(opt, "bin") },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(r.exitCode).toBe(0);
  expect(r.stdout.toString()).toBe(executableLeaf);
  const leafLink = join(cellar, "bun-link");
  symlinkSync(executableLeaf, leafLink);
  const rejected = Bun.spawnSync(["/bin/bash", "-c", probe], {
    cwd: root,
    env: { ...process.env, OPT_DIR: join(opt, "bin"), TARGET_LEAF: leafLink },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(rejected.exitCode).not.toBe(0);
  rmSync(root, { recursive: true, force: true });
});
const rootFailureProbe = String.raw`
set -euf
SCRIPT_FAILURE_PREFIX="$H3_SCRIPT_FAILURE_PREFIX"
SCRIPT_SOURCE="\${BASH_SOURCE[0]}"
SCRIPT_DIR="\${SCRIPT_SOURCE%/*}"
[ "$SCRIPT_DIR" = "$SCRIPT_SOURCE" ] && SCRIPT_DIR=.
if [ "\${H3_ROOT_FAILURE:-}" = script_dir ]; then SCRIPT_DIR="$H3_ROOT_MISSING"; fi
if ! SCRIPT_DIR="$(CDPATH= cd -- "$SCRIPT_DIR" 2>/dev/null && pwd -P)"; then
  echo "$SCRIPT_FAILURE_PREFIX failed (workspace)" >&2
  exit 1
fi
if [ "\${H3_ROOT_FAILURE:-}" = repo_root ]; then SCRIPT_DIR="$H3_ROOT_MISSING"; fi
if ! REPO_ROOT="$(CDPATH= cd -- "$SCRIPT_DIR/.." 2>/dev/null && pwd -P)"; then
  echo "$SCRIPT_FAILURE_PREFIX failed (workspace)" >&2
  exit 1
fi
if [ "\${H3_ROOT_FAILURE:-}" = repo_cd ]; then REPO_ROOT="$H3_ROOT_MISSING"; fi
if ! cd "$REPO_ROOT" 2>/dev/null; then
  echo "$SCRIPT_FAILURE_PREFIX failed (workspace)" >&2
  exit 1
fi
printf '%s\n' ok
`;
test.each(["script_dir", "repo_root", "repo_cd"] as const)(
  "guarded canonical root derivation reports fixed workspace failure for %s",
  (failure) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "minime-h3-root-failure-")));
    const r = Bun.spawnSync(["/bin/bash", "-c", rootFailureProbe], {
      cwd: root,
      env: {
        PATH: "/definitely-hostile",
        H3_ROOT_FAILURE: failure,
        H3_ROOT_MISSING: join(root, "missing-root"),
        H3_SCRIPT_FAILURE_PREFIX: "restore drill",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(r.exitCode).toBe(1);
    expect(r.stdout.toString()).toBe("");
    expect(r.stderr.toString()).toBe("restore drill failed (workspace)\n");
    rmSync(root, { recursive: true, force: true });
  },
);
test.each([
  ["restore-drill.sh", "restore drill"],
  ["restore-pitr.sh", "restore pitr"],
  ["promote-restore.sh", "promotion"],
] as const)("resolver dependency failure is fixed for %s", (script, label) => {
  const f = shellFixture({ resolverFailure: "mktemp" });
  const r = f.run(script);
  expect(r.code).not.toBe(0);
  expect(r.out).toBe("");
  expect(r.err).toBe(`${label} failed (cleanup_dependency)\n`);
  expect(readdirSync(r.scratch)).toEqual([]);
  expectNoConnectionSecrets(r);
});
test.each([
  ["restore-drill.sh", "restore drill"],
  ["restore-pitr.sh", "restore pitr"],
  ["promote-restore.sh", "promotion"],
] as const)("configured restic failure is fixed for %s", (script, label) => {
  const f = shellFixture({ resolverFailure: "restic" });
  const r = f.run(script, { RESTIC_REPOSITORY: "test:repo" });
  expect(r.code).not.toBe(0);
  expect(r.out).toBe("");
  expect(r.err).toBe(`${label} failed (cleanup_dependency)\n`);
  expect(readdirSync(r.scratch)).toEqual([]);
  expectNoConnectionSecrets(r);
});
test.each([
  ["restore-drill.sh", "restore drill"],
  ["restore-pitr.sh", "restore pitr"],
  ["promote-restore.sh", "promotion"],
] as const)("explicit RESTIC_BIN failure is fixed for %s", (script, label) => {
  const f = shellFixture({ resolverFailure: "restic" });
  const r = f.run(script, { RESTIC_BIN: "/requested/restic" });
  expect(r.code).not.toBe(0);
  expect(r.out).toBe("");
  expect(r.err).toBe(`${label} failed (cleanup_dependency)\n`);
  expect(readdirSync(r.scratch)).toEqual([]);
  expectNoConnectionSecrets(r);
});

const hostileUtilityRows = [
  {
    name: "workspace mktemp failure",
    script: "restore-drill.sh",
    utility: "mktemp",
    phase: "workspace allocation",
    env: { H3_TRUSTED_UTILITY_FAILURE: "mktemp" },
    marker: "H3_UTILITY_MKTEMP_path_credential_SENTINEL",
    expectedExit: 1,
    expectedStdout: fixedOutput(),
    expectedStderr: fixedOutput("restore drill failed (workspace)"),
  },
  {
    name: "workspace chmod failure",
    script: "restore-pitr.sh",
    utility: "chmod",
    phase: "workspace mode",
    env: { H3_TRUSTED_UTILITY_FAILURE: "chmod" },
    marker: "H3_UTILITY_CHMOD_path_credential_SENTINEL",
    expectedExit: 1,
    expectedStdout: fixedOutput(),
    expectedStderr: fixedOutput("restore pitr failed (workspace)"),
  },
  {
    name: "restic extraction mkdir failure",
    script: "restore-drill.sh",
    utility: "mkdir",
    phase: "private restic directory",
    env: { RESTIC_REPOSITORY: "test:repo", H3_TRUSTED_UTILITY_FAILURE: "mkdir" },
    marker: "H3_UTILITY_MKDIR_path_credential_SENTINEL",
    expectedExit: 1,
    expectedStdout: fixedOutput("==> restoring latest private snapshot"),
    expectedStderr: fixedOutput("restore drill failed (workspace)"),
  },
  {
    name: "snapshot find failure",
    script: "restore-pitr.sh",
    utility: "find",
    phase: "restored dump discovery",
    env: { RESTIC_REPOSITORY: "test:repo", H3_TRUSTED_UTILITY_FAILURE: "find" },
    marker: "H3_UTILITY_FIND_path_credential_SENTINEL",
    expectedExit: 1,
    expectedStdout: fixedOutput(
      "==> selecting private snapshot",
      "==> restoring selected private snapshot",
    ),
    expectedStderr: fixedOutput("restore pitr failed (snapshot_dump_missing)"),
  },
  {
    name: "restore-drill snapshot copy failure",
    script: "restore-drill.sh",
    utility: "cp",
    phase: "restored dump adoption",
    env: { RESTIC_REPOSITORY: "test:repo", H3_TRUSTED_UTILITY_FAILURE: "cp" },
    marker: "H3_UTILITY_CP_path_credential_SENTINEL",
    expectedExit: 1,
    expectedStdout: fixedOutput("==> restoring latest private snapshot"),
    expectedStderr: fixedOutput("restore drill failed (snapshot_dump_missing)"),
  },
  {
    name: "restore-pitr snapshot copy failure",
    script: "restore-pitr.sh",
    utility: "cp",
    phase: "restored dump adoption",
    env: { RESTIC_REPOSITORY: "test:repo", H3_TRUSTED_UTILITY_FAILURE: "cp" },
    marker: "H3_UTILITY_CP_path_credential_SENTINEL",
    expectedExit: 1,
    expectedStdout: fixedOutput(
      "==> selecting private snapshot",
      "==> restoring selected private snapshot",
    ),
    expectedStderr: fixedOutput("restore pitr failed (snapshot_dump_missing)"),
  },
  {
    name: "restore-pitr snapshot cut failure",
    script: "restore-pitr.sh",
    utility: "cut",
    phase: "snapshot selection",
    env: { RESTIC_REPOSITORY: "test:repo", H3_TRUSTED_UTILITY_FAILURE: "cut" },
    marker: "H3_UTILITY_CUT_path_credential_SENTINEL",
    expectedExit: 1,
    expectedStdout: fixedOutput("==> selecting private snapshot"),
    expectedStderr: fixedOutput("restore pitr failed (snapshot_selection)"),
  },
  {
    name: "promote parent stat failure",
    script: "promote-restore.sh",
    utility: "stat",
    phase: "canonical dump-root preflight",
    env: { H3_TRUSTED_UTILITY_FAILURE: "stat" },
    marker: "H3_UTILITY_STAT_path_credential_SENTINEL",
    expectedExit: 1,
    expectedStdout: fixedOutput(),
    expectedStderr: fixedOutput("promotion failed (private_dump_root)"),
  },
  {
    name: "promote retention tail failure",
    script: "promote-restore.sh",
    utility: "tail",
    phase: "local safety retention",
    env: { H3_TRUSTED_UTILITY_FAILURE: "tail" },
    marker: "H3_UTILITY_TAIL_path_credential_SENTINEL",
    expectedExit: 1,
    expectedStdout: fixedOutput(
      "==> checking for live connections",
      "==> dumping live database to canonical pre-promote safety net",
    ),
    expectedStderr: fixedOutput("promotion failed (retention)"),
  },
  {
    name: "promote admin query tr failure",
    script: "promote-restore.sh",
    utility: "tr",
    phase: "admin query normalization",
    env: { H3_TRUSTED_UTILITY_FAILURE: "tr" },
    marker: "H3_UTILITY_TR_path_credential_SENTINEL",
    expectedExit: 7,
    expectedStdout: fixedOutput(),
    expectedStderr: fixedOutput("promotion failed (psql)"),
  },
  {
    name: "promote retention sort failure",
    script: "promote-restore.sh",
    utility: "sort",
    phase: "local safety retention",
    env: { H3_TRUSTED_UTILITY_FAILURE: "sort" },
    marker: "H3_UTILITY_SORT_path_credential_SENTINEL",
    expectedExit: 1,
    expectedStdout: fixedOutput(
      "==> checking for live connections",
      "==> dumping live database to canonical pre-promote safety net",
    ),
    expectedStderr: fixedOutput("promotion failed (retention)"),
  },
  {
    name: "cleanup rm failure preserves primary result",
    script: "restore-drill.sh",
    utility: "rm",
    phase: "EXIT cleanup",
    env: { H3_TRUSTED_UTILITY_FAILURE: "rm" },
    marker: "H3_UTILITY_RM_path_credential_SENTINEL",
    expectedExit: 1,
    expectedStdout: fixedOutput(
      "==> creating fresh source database dump",
      "==> restoring into private scratch database",
      "==> validating restored database",
      "==> restore drill green",
    ),
    expectedStderr: fixedOutput("restore drill failed (cleanup_failed)"),
  },
] as const;

for (const row of hostileUtilityRows) {
  test(`hostile utility: ${row.name}`, () => {
    const f = shellFixture();
    const r = f.run(row.script as "restore-drill.sh" | "restore-pitr.sh" | "promote-restore.sh", {
      ...row.env,
      H3_UTILITY_SENTINEL: row.marker,
    });
    expect(r.code).toBe(row.expectedExit);
    expect(r.out.replace(/\r\n/g, "\n")).toBe(row.expectedStdout);
    expect(r.err.replace(/\r\n/g, "\n")).toBe(row.expectedStderr);
    expectNoMarker(r, row.marker);
    expectTrustedInterception(r, row.utility);
    if (row.utility === "rm") expect(readdirSync(r.scratch).length).toBeGreaterThan(0);
    else expect(readdirSync(r.scratch)).toEqual([]);
    expectNoConnectionSecrets(r);
  });
}

test("completed restore scripts contain only the absolute executable allowlist", () => {
  const f = shellFixture();
  const scripts = ["restore-drill.sh", "restore-pitr.sh", "promote-restore.sh"] as const;
  const external =
    /(?:^|[;&|]\s*)(?:mkdir|chmod|mktemp|find|cat|cut|tr|sort|tail|stat|ls|cp|mv|install|rm|realpath|dirname|date|brew|bun|restic|pg_dump|psql)(?:\s|$)/m;
  for (const script of scripts) {
    const body = readFileSync(join(f.fixtureScripts, script), "utf8");
    expect(body).not.toMatch(external);
    expect(body).not.toMatch(/\beval\b|\bcommand -v\b/);
    expect(body).not.toMatch(/\$PGBIN\/(?:pg_dump|psql)/);
    expect(body).toContain("$TRUSTED_DIRNAME");
    expect(body).toContain("$TRUSTED_PG_DUMP");
    expect(body).toContain("$TRUSTED_PSQL");
  }
  for (const utility of ["pg_dump", "psql", "restic", "bun"] as const) {
    const fake = readFileSync(
      join(utility === "pg_dump" || utility === "psql" ? f.pgBin : f.trustedBin, utility),
      "utf8",
    );
    expect(fake).not.toMatch(/(?:^|[;&|[:space:]])(?:grep|mkdir|chmod|stat|cat)(?:[[:space:]]|$)/m);
  }
});

test("scratch restores clone the installer extension template before replay", () => {
  const expected = {
    "restore-drill.sh": "create database minime_drill with owner minime template minime_test",
    "restore-pitr.sh": "create database minime_restore with owner minime template minime_test",
  } as const;
  for (const [script, statement] of Object.entries(expected)) {
    const body = readFileSync(join(REPO, "scripts", script), "utf8");
    expect(body).toContain(statement);
    expect(body).not.toContain("create extension if not exists vector");
  }
  const drill = readFileSync(join(REPO, "scripts", "restore-drill.sh"), "utf8");
  for (const option of ["--no-comments"]) {
    expect(drill).toContain(option);
  }
  expect(drill).toContain('drill_psql -qAt -c "drop owned by minime cascade"');
  expect(readFileSync(join(REPO, "scripts", "restore-pitr.sh"), "utf8")).toContain(
    'restore_psql -qAt -c "drop owned by minime cascade"',
  );
});

test.each([
  [
    "restore-drill.sh",
    "restore drill",
    {
      DRILL_URL: "postgres://h3-drill-user:drill-credential-sentinel@localhost:5432/minime",
    },
  ],
  [
    "restore-pitr.sh",
    "restore pitr",
    {
      RESTIC_REPOSITORY: "test:repo",
      RESTORE_URL: "postgres://h3-restore-user:restore-credential-sentinel@localhost:5432/minime",
    },
  ],
] as const)("%s rejects a live replay target before any database command", (script, label, env) => {
  const f = shellFixture();
  const r = f.run(script, env);
  expect(r.code).toBe(1);
  expect(r.err).toBe(`${label} failed (endpoint_boundary)\n`);
  expect(r.trace).not.toContain("command=psql");
  expect(r.trace).not.toContain("command=restic");
  expectNoConnectionSecrets(r);
});

test("persistent cleanup refusal never falls back to recursive trusted find deletion", () => {
  for (const script of ["restore-drill.sh", "restore-pitr.sh", "promote-restore.sh"] as const) {
    const body = readFileSync(join(REPO, "scripts", script), "utf8");
    expect(body).not.toContain("-depth -delete");
    expect(body).not.toMatch(/\$TRUSTED_FIND[^\n]*\b-delete\b/);
  }
});

test("promote retention uses portable direct-child enumeration without GNU maxdepth", () => {
  const body = readFileSync(join(REPO, "scripts", "promote-restore.sh"), "utf8");
  expect(body).not.toContain("-maxdepth");
  expect(body).toContain("minime-pre-promote-");
});
