// W4 repair runner (improve-w4-roles.md): the ONLY sanctioned ad-hoc write path to the live
// DB besides MCP tools and `make migrate`. Contract: named COMMITTED repair script → automatic
// pre-image pg_dump (no backup ⇒ no repair) → run as the owner role → repair:* audit events
// with counts only. Formalizes the manual backup→fix→read-back discipline from DECISIONS.md
// 2026-06-16.
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { logEvent } from "../src/db/repo";
import { config } from "../src/util/config";

export interface RepairModule {
  name: string;
  description: string;
  run(args: string[]): Promise<Record<string, number | string>>;
}

// HEAD, not the index: a merely-staged script passes `git ls-files` but a `git reset`
// would erase all trace of what ran — commit-history truth is the contract.
async function committed(scriptName: string): Promise<boolean> {
  const proc = Bun.spawn(["git", "cat-file", "-e", `HEAD:scripts/repairs/${scriptName}.ts`], {
    stderr: "pipe",
  });
  return (await proc.exited) === 0;
}

async function preImageDump(scriptName: string, dumpDir: string): Promise<string | null> {
  await mkdir(dumpDir, { recursive: true }).catch(() => {});
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const file = join(dumpDir, `repair-${scriptName}-${ts}.sql`);
  const proc = Bun.spawn(["pg_dump", "--no-owner", "-f", file, config.databaseUrl], {
    stderr: "pipe",
  });
  if ((await proc.exited) !== 0) return null;
  const size = (await Bun.file(file).exists()) ? Bun.file(file).size : 0;
  return size > 0 ? file : null;
}

export async function runRepair(
  scriptName: string,
  args: string[],
  opts: { dumpDir?: string } = {},
): Promise<number> {
  if (!/^[a-z0-9-]+$/.test(scriptName)) {
    console.error("invalid repair name");
    return 2;
  }
  if (!(await committed(scriptName))) {
    console.error(`refusing: scripts/repairs/${scriptName}.ts is not in a committed tree (HEAD)`);
    return 2;
  }
  const mod = (await import(`./repairs/${scriptName}.ts`)).default as RepairModule;
  if (mod.name !== scriptName) {
    console.error("repair module name mismatch");
    return 2;
  }
  const backup = await preImageDump(scriptName, opts.dumpDir ?? join(process.cwd(), "db-dump"));
  if (!backup) {
    console.error("refusing: pre-image backup failed (no backup ⇒ no repair)");
    return 2;
  }
  await logEvent({
    actor: "system:repair",
    verb: `repair:${scriptName}`,
    payload: { phase: "start", args_count: args.length, backup },
  });
  try {
    const summary = await mod.run(args);
    await logEvent({
      actor: "system:repair",
      verb: `repair:${scriptName}`,
      payload: { phase: "done", backup, ...summary },
    });
    console.log(`repair ${scriptName} done — backup: ${backup}`);
    console.log(JSON.stringify(summary, null, 2));
    return 0;
  } catch (e) {
    await logEvent({
      actor: "system:repair",
      verb: `repair:${scriptName}`,
      payload: { phase: "failed", backup, error: e instanceof Error ? e.message : String(e) },
    });
    console.error(
      `repair failed (pre-image backup at ${backup}): ${e instanceof Error ? e.message : e}`,
    );
    return 1;
  }
}

if (import.meta.main) {
  const [name, ...args] = process.argv.slice(2);
  if (!name) {
    console.error("usage: bun run scripts/repair.ts <script> [--k=v ...]");
    process.exit(2);
  }
  process.exit(await runRepair(name, args));
}
