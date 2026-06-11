// minime <cmd> — ops CLI (spec §5). The chat agent is the interface; this is for plumbing.

import { Cron } from "croner";
import { closeDb } from "./db/client";
import { migrate } from "./db/migrate";
import { eventsSince } from "./db/repo";
import { importCalendar } from "./importers/calendar";
import { importEmailMeta } from "./importers/email-meta";
import { importHealth } from "./importers/health";
import { type TxProfile, importTransactions } from "./importers/transactions";
import { startMcpServer } from "./mcp/server";
import { brainSync } from "./pipeline/brain-sync";
import { dream } from "./pipeline/dream";
import { startWatcher } from "./pipeline/watcher";
import { drainEmbedBacklog } from "./search/index-parent";
import { config } from "./util/config";

const USAGE = `minime <command>

  migrate                          apply pending db/migrations/*.sql
  seed                             load the fictional demo dataset (fixtures/seed.ts)
  sync                             sync data/brain/**/*.md into pages + chunks
  embed                            drain the embedding backlog
  reembed                          wipe + re-embed all chunks (after switching embed provider/model)
  dream                            run the nightly maintenance job once
  serve                            MCP server (stdio) + inbox watcher + dream cron
  audit --since <Nd>               show what left the box (events), default 7d
  import:calendar <file.ics>
  import:transactions <file.csv> --profile <bank>
  import:health <export.xml>
  import:email-meta <Maildir/>
`;

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<number> {
  const cmd = process.argv[2];
  const target = process.argv[3];
  switch (cmd) {
    case "migrate": {
      const ran = await migrate();
      console.log(ran.length ? `applied: ${ran.join(", ")}` : "up to date");
      return 0;
    }
    case "seed": {
      await migrate();
      const { seed } = await import("../fixtures/seed");
      const result = await seed();
      console.log(`seeded: ${JSON.stringify(result)}`);
      return 0;
    }
    case "sync": {
      const stats = await brainSync();
      console.log(`brain sync: ${JSON.stringify(stats)}`);
      return 0;
    }
    case "embed": {
      const n = await drainEmbedBacklog();
      console.log(`embedded ${n} chunks`);
      return 0;
    }
    case "reembed": {
      // full wipe + re-embed: required when switching EMBED_PROVIDER or embed model,
      // because vectors from different models are not comparable
      const { clearEmbeddings, embedModelsInUse } = await import("./db/repo");
      const { embedModelName } = await import("./llm");
      const old = await embedModelsInUse();
      const wiped = await clearEmbeddings();
      console.log(`wiped ${wiped} embeddings (was: ${old.join(", ") || "none"})`);
      const n = await drainEmbedBacklog();
      console.log(`re-embedded ${n} chunks with ${embedModelName()}`);
      return 0;
    }
    case "dream": {
      const summary = await dream();
      console.log(JSON.stringify(summary, null, 2));
      return 0;
    }
    case "serve": {
      await migrate();
      startWatcher();
      const cron = new Cron(config.dreamCron, () => {
        dream().catch((e) => console.error(`[minime] dream failed: ${e?.message ?? e}`));
      });
      console.error(
        `[minime] dream scheduled: ${config.dreamCron} (next: ${cron.nextRun()?.toISOString()})`,
      );
      await startMcpServer();
      return -1; // stay alive on stdio
    }
    case "audit": {
      const since = arg("--since") ?? "7d";
      const days = Number(since.match(/^(\d+)d$/)?.[1] ?? 7);
      const rows = await eventsSince(new Date(Date.now() - days * 86_400_000));
      for (const r of rows) {
        const p = r.payload ?? {};
        const ids =
          Array.isArray(p.returned_ids) && p.returned_ids.length
            ? ` ids=${p.returned_ids.length}`
            : "";
        console.log(
          `${new Date(r.at).toISOString()}  ${r.actor.padEnd(24)} ${r.verb}${ids}${p.error ? ` ERROR=${p.error}` : ""}`,
        );
      }
      console.log(`-- ${rows.length} events in last ${days}d`);
      return 0;
    }
    case "import:calendar": {
      if (!target) break;
      console.log(JSON.stringify(await importCalendar(await Bun.file(target).text())));
      return 0;
    }
    case "import:transactions": {
      const profileName = arg("--profile");
      if (!target || !profileName) break;
      const profile = (await Bun.file(
        `config/tx-profiles/${profileName}.json`,
      ).json()) as TxProfile;
      console.log(JSON.stringify(await importTransactions(await Bun.file(target).text(), profile)));
      return 0;
    }
    case "import:health": {
      if (!target) break;
      console.log(JSON.stringify(await importHealth(target)));
      return 0;
    }
    case "import:email-meta": {
      if (!target) break;
      console.log(JSON.stringify(await importEmailMeta(target)));
      return 0;
    }
  }
  console.error(USAGE);
  return 1;
}

const code = await main();
if (code >= 0) {
  await closeDb();
  process.exit(code);
}
