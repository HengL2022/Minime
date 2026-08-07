// minime <cmd> — ops CLI (spec §5). The chat agent is the interface; this is for plumbing.

import { join } from "node:path";
import { closeDb, withAdminDbTransaction } from "./db/client";
import { assertSchemaCurrent, migrate, parseMigrationCliContext } from "./db/migrate";
import {
  type PendingTier2UnlockRequest,
  approveTier2UnlockRequest,
  eventsSince,
  pendingTier2UnlockRequests,
} from "./db/repo";
import { importCalendar } from "./importers/calendar";
import { importEmailMeta } from "./importers/email-meta";
import { importHealth } from "./importers/health";
import { type TxProfile, importTransactions } from "./importers/transactions";
import { validateProviderRoutes } from "./llm";
import { startMcpServer } from "./mcp/server";
import { dbSnapshot, preUpdateSnapshot } from "./pipeline/backup";
import { brainSync } from "./pipeline/brain-sync";
import { dream } from "./pipeline/dream";
import { startWatcher } from "./pipeline/watcher";
import { drainEmbedBacklog } from "./search/index-parent";
import {
  assertRuntimeChildBoundary,
  runtimeChildEnvironment,
  spawnRuntimeChild,
  startOwnerMaintenanceSchedule,
  superviseRuntimeChild,
} from "./serve";
import { REPO_ROOT, config, repositoryInstallPendingState } from "./util/config";
import { ollamaPreflight } from "./util/ollama-url";
import { parseLocalPostgresUrl, samePostgresServer } from "./util/postgres-url";

const USAGE = `minime <command>

  migrate                          apply pending db/migrations/*.sql
  seed                             load the fictional demo dataset (fixtures/seed.ts)
  sync                             sync data/brain/**/*.md into pages + chunks
  embed                            drain the embedding backlog
  reembed                          wipe + re-embed all chunks (after switching embed provider/model)
  onboard                          first-run interview: seed your values, goals, people, projects
  dream                            run the nightly maintenance job once
  backup                           take a tagged db snapshot now (pg_dump -> restic db-snap)
  backup:pre-update                take the fail-closed pre-update db snapshot
  unlock:approve <request-id>      approve one pending tier-2 request for its MCP connection
  unlock:approve --latest          approve the single pending request (refuses if more than one)
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

/** Resident MCP must always use a distinct restricted app DSN, never owner fallback. */
export function assertServeRuntimeRole(
  runtimeRaw = process.env.MINIME_APP_DATABASE_URL?.trim(),
  ownerRaw = config.databaseUrl,
): void {
  if (!runtimeRaw) throw new Error("runtime_role_required");
  try {
    const runtime = parseLocalPostgresUrl(runtimeRaw, "minime");
    const owner = parseLocalPostgresUrl(ownerRaw, "minime");
    const ownerUser = decodeURIComponent(owner.url.username);
    const runtimeUser = decodeURIComponent(runtime.url.username);
    if (
      !samePostgresServer(runtime, owner) ||
      !ownerUser ||
      ownerUser === "minime_app" ||
      runtimeUser !== "minime_app" ||
      !runtime.url.password ||
      runtime.url.toString() === owner.url.toString()
    ) {
      throw new Error("runtime_role_required");
    }
  } catch {
    throw new Error("runtime_role_required");
  }
}

/** Thrown inside the `--latest` transaction so the caller can list every pending request. */
class AmbiguousLatestUnlockError extends Error {
  constructor(readonly pending: PendingTier2UnlockRequest[]) {
    super("unlock_request_ambiguous");
  }
}

async function main(): Promise<number> {
  const cmd = process.argv[2];
  if (cmd === "migrate" || cmd === "serve" || cmd === "serve:runtime") {
    const installState = repositoryInstallPendingState();
    if (installState !== "ready") {
      console.error(
        installState === "pending"
          ? "ERROR: PostgreSQL installation bootstrap is incomplete"
          : "ERROR: PostgreSQL installation lifecycle state is invalid",
      );
      console.error("FIX: run bash scripts/install.sh before migrate or serve");
      return 40;
    }
  }
  if (cmd === "backup:pre-update") {
    const outcome = await preUpdateSnapshot();
    if (outcome.kind === "taken") return 0;
    if (outcome.kind === "unconfigured") return 3;
    return 1;
  }
  if (cmd === "unlock:approve") {
    const requestArg = process.argv[3];
    const isLatest = requestArg === "--latest";
    const isUuid =
      typeof requestArg === "string" &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestArg);
    if (!requestArg || process.argv.length !== 4 || !(isUuid || isLatest)) {
      console.error("ERROR: unlock request id is invalid");
      console.error("FIX: copy the request id returned by minime_unlock, or pass --latest");
      return 2;
    }
    try {
      await assertSchemaCurrent();
    } catch (error) {
      if (error instanceof Error && error.message === "schema_not_current") {
        console.error("ERROR: schema is not current");
        console.error("FIX: run make migrate, or rerun make update");
        return 50;
      }
      throw error;
    }
    try {
      // Listing and approving share one admin transaction: approveTier2UnlockRequest
      // re-validates scope/window/ceiling itself, so a request that goes stale between the
      // list and the approval is simply left unapproved, never wrongly approved.
      const approved = await withAdminDbTransaction(async () => {
        if (isUuid) return approveTier2UnlockRequest(requestArg);
        const pending = await pendingTier2UnlockRequests();
        if (pending.length > 1) throw new AmbiguousLatestUnlockError(pending);
        if (pending.length === 0) throw new Error("unlock_request_none_pending");
        return approveTier2UnlockRequest(pending[0]!.id);
      });
      console.log(
        `approved tier-2 request ${approved.id} for ${approved.minutes}min, requested by ` +
          `${approved.requestedBy}, until ${approved.expires_at.toISOString()}`,
      );
      return 0;
    } catch (error) {
      if (error instanceof AmbiguousLatestUnlockError) {
        console.error("ERROR: more than one unlock request is pending within the approval window");
        for (const request of error.pending) {
          const ageMinutes = Math.max(
            0,
            Math.floor((Date.now() - request.requestedAt.getTime()) / 60_000),
          );
          console.error(
            `  ${request.id}  requested_by=${request.requestedBy}  requested ${ageMinutes}min ago`,
          );
        }
        console.error("FIX: rerun with the exact request id you want to approve");
        return 1;
      }
      if (error instanceof Error && error.message === "unlock_request_none_pending") {
        console.error("ERROR: no pending unlock request within the approval window");
        console.error("FIX: ask the agent to create a fresh minime_unlock request");
        return 1;
      }
      if (error instanceof Error && error.message === "unlock_request_not_approvable") {
        console.error("ERROR: unlock request is not pending and eligible");
        console.error("FIX: ask the agent to create a fresh minime_unlock request");
        return 1;
      }
      throw error;
    }
  }
  const ollama = ollamaPreflight(config.ollamaUrl);
  if (!ollama.ok) {
    console.error(ollama.error);
    console.error(ollama.fix);
    return ollama.exitCode;
  }
  if (cmd === "migrate") {
    let context: Parameters<typeof migrate>[0];
    try {
      context = parseMigrationCliContext(process.argv.slice(3));
    } catch (error) {
      const kind = error instanceof Error ? error.message : "migration_context_invalid";
      if (kind === "migration_context_required") {
        console.error("ERROR: migration context required");
        console.error("FIX: run make migrate, or rerun make update");
      } else {
        console.error("ERROR: migration context invalid");
        console.error("FIX: run make migrate, or rerun make update");
      }
      return 50;
    }
    try {
      const ran = await migrate(context);
      console.log(ran.length ? `applied: ${ran.join(", ")}` : "up to date");
      return 0;
    } catch (error) {
      if (error instanceof Error && error.message === "migration_context_target") {
        console.error("ERROR: migration context target invalid");
        console.error("FIX: run make migrate, or rerun make update");
        return 50;
      }
      throw error;
    }
  }
  const target = process.argv[3];
  switch (cmd) {
    case "seed": {
      try {
        await assertSchemaCurrent();
      } catch (error) {
        if (error instanceof Error && error.message === "schema_not_current") {
          console.error("ERROR: schema is not current");
          console.error("FIX: run make migrate, or rerun make update");
          return 50;
        }
        throw error;
      }
      const { seed } = await import("../fixtures/seed");
      const result = await withAdminDbTransaction(() => seed());
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
      try {
        validateProviderRoutes();
      } catch (e) {
        console.error(e instanceof Error ? e.message : String(e));
        return 1;
      }
      const summary = await dream();
      console.log(JSON.stringify(summary, null, 2));
      return 0;
    }
    case "onboard": {
      try {
        await assertSchemaCurrent();
      } catch (error) {
        if (error instanceof Error && error.message === "schema_not_current") {
          console.error("ERROR: schema is not current");
          console.error("FIX: run make migrate, or rerun make update");
          return 50;
        }
        throw error;
      }
      const { onboard } = await import("./onboard");
      await withAdminDbTransaction(() => onboard());
      return 0;
    }
    case "backup": {
      // exit 1 when nothing was snapshotted so callers (scripts/update.sh) can WARN
      const r = await dbSnapshot();
      console.log(`${r.ran ? "snapshot taken" : "skipped"}: ${r.detail}`);
      return r.ran ? 0 : 1;
    }
    case "serve": {
      try {
        assertServeRuntimeRole();
      } catch {
        console.error("ERROR: restricted runtime app role is not configured");
        console.error("FIX: run make migrate && make provision-runtime-role");
        return 40;
      }
      try {
        validateProviderRoutes();
      } catch (e) {
        console.error(e instanceof Error ? e.message : String(e));
        return 1;
      }
      try {
        runtimeChildEnvironment(process.env, config.runtimeDatabaseUrl);
      } catch {
        console.error("ERROR: restricted runtime child configuration is invalid");
        console.error(
          "FIX: run make setup and configure the dedicated runtime provider credentials",
        );
        return 40;
      }
      try {
        await assertSchemaCurrent();
      } catch (error) {
        if (error instanceof Error && error.message === "schema_not_current") {
          console.error("ERROR: schema is not current");
          console.error("FIX: run make migrate, or rerun make update");
          return 50;
        }
        throw error;
      }
      const schedule = startOwnerMaintenanceSchedule();
      try {
        const child = spawnRuntimeChild(config.runtimeDatabaseUrl);
        return await superviseRuntimeChild(child);
      } finally {
        await schedule.close();
      }
    }
    case "serve:runtime": {
      try {
        assertRuntimeChildBoundary();
        validateProviderRoutes();
      } catch {
        console.error("runtime_child_boundary_invalid");
        return 40;
      }
      let resolveStop!: (code: number) => void;
      const stopped = new Promise<number>((resolve) => {
        resolveStop = resolve;
      });
      let requested = false;
      const stop = (code: number) => {
        if (requested) return;
        requested = true;
        resolveStop(code);
      };
      const onSigint = () => stop(130);
      const onSigterm = () => stop(143);
      const onEnd = () => stop(0);
      process.once("SIGINT", onSigint);
      process.once("SIGTERM", onSigterm);
      process.stdin.once("end", onEnd);
      let watcher: Awaited<ReturnType<typeof startWatcher>> | undefined;
      let server: Awaited<ReturnType<typeof startMcpServer>> | undefined;
      try {
        watcher = await startWatcher();
        server = await startMcpServer();
        void server.closed.then(() => stop(0));
        return await stopped;
      } finally {
        process.removeListener("SIGINT", onSigint);
        process.removeListener("SIGTERM", onSigterm);
        process.stdin.removeListener("end", onEnd);
        await Promise.allSettled([watcher?.close(), server?.close()]);
      }
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
      if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(profileName)) {
        console.error("ERROR: transaction profile name is invalid");
        console.error("FIX: choose a profile name from config/tx-profiles without .json");
        return 2;
      }
      const profile = (await Bun.file(
        join(REPO_ROOT, "config", "tx-profiles", `${profileName}.json`),
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
