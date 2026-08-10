// minime <cmd> — ops CLI (spec §5). The chat agent is the interface; this is for plumbing.

import { join } from "node:path";
import { closeDb, withAdminDbTransaction } from "./db/client";
import { assertSchemaCurrent, migrate, parseMigrationCliContext } from "./db/migrate";
import {
  type AuditSummary,
  type EntityKind,
  type PendingTier2UnlockRequest,
  type Tier0HealthSampleRow,
  type Tier0TransactionRow,
  approveTier2UnlockRequest,
  auditSummarySince,
  eventsSince,
  getInboxItem,
  insertMetricDef,
  listHealthSamples,
  listTransactions,
  logEvent,
  openReviewItems,
  pendingAndActiveUnlocks,
  pendingEntityPromotions,
  pendingTier2UnlockRequests,
  restoreEntityTier,
  revokeTier2Unlock,
} from "./db/repo";
import { importCalendar } from "./importers/calendar";
import { importEmailMeta } from "./importers/email-meta";
import { importHealth } from "./importers/health";
import { type TxProfile, importTransactions } from "./importers/transactions";
import { validateProviderRoutes } from "./llm";
import { startMcpServer } from "./mcp/server";
import { type DoctorCheck, runDoctorChecks } from "./ops/doctor";
import { dbSnapshot, preUpdateSnapshot } from "./pipeline/backup";
import { brainSync } from "./pipeline/brain-sync";
import { dream } from "./pipeline/dream";
import { readArchivedCapture, startWatcher, storedClassification } from "./pipeline/watcher";
import { drainEmbedBacklog } from "./search/index-parent";
import {
  assertRuntimeChildBoundary,
  runtimeChildEnvironment,
  spawnRuntimeChild,
  startOwnerMaintenanceSchedule,
  superviseRuntimeChild,
} from "./serve";
import { auditPayload } from "./util/audit-payload";
import { REPO_ROOT, config, repositoryInstallPendingState } from "./util/config";
import {
  METRIC_TEMPLATE_DEFAULT_DESCRIPTION,
  METRIC_TEMPLATE_IDS,
  type MetricTemplateId,
  type MetricTemplateParams,
  generateMetricTemplate,
  isMetricTemplateId,
} from "./util/metric-templates";
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
  doctor                           print a content-free maintenance/ops health checklist
  backup                           take a tagged db snapshot now (pg_dump -> restic db-snap)
  backup:pre-update                take the fail-closed pre-update db snapshot
  unlock:approve <request-id>      approve one pending tier-2 request for its MCP connection
  unlock:approve --latest          approve the single pending request (refuses if more than one)
  unlock:status                    list pending tier-2 requests and active approvals with remaining minutes
  unlock:revoke <request-id>       end one active tier-2 approval immediately
  unlock:revoke --all              end every currently active tier-2 approval immediately
  entity:restore-tier --list       list pending entity_promotion review items, with names
  entity:restore-tier <person|org> <id>
                                    demote one person/org identity from tier 2 back to tier 1
  tx list --month YYYY-MM [--match text] [--limit N]
                                    print tier-0 transactions for one month (owner terminal only)
  health list --kind <kind> [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--limit N]
                                    print tier-0 health samples of one kind (owner terminal only)
  metric:add --name <name> --template <health-sum|health-avg|health-count|spend-by-category|spend-by-merchant> --unit <unit>
              [--kind K] [--category C] [--merchant-pattern P] [--description D]
                                    create a metric_defs row from a vetted template (owner terminal only; no --sql flag)
  serve                            MCP server (stdio) + inbox watcher + dream cron
  review                           list open inbox_unfiled/duplicate items with full text (owner; no unlock needed)
  audit --since <Nd>               show what left the box (events), default 7d
              [--summary] [--verb <pattern>] [--actor <actor>]
                                    --summary: actor/verb + egress + unlock rollups on one screen
                                    (ignores --verb/--actor); otherwise raw lines, filterable by
                                    exact --actor or --verb (glob, '*' -> SQL LIKE '%', e.g. 'egress:*')
  import:calendar <file.ics>
  import:transactions <file.csv> --profile <bank>
  import:health <export.xml>
  import:email-meta <Maildir/>
`;

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

type MetricTemplateFlagResolution =
  | { params: MetricTemplateParams }
  | { missingFlag: "--kind" | "--category" | "--merchant-pattern" };

// Maps `metric:add --template <id>` to the one scalar flag that template needs, reading it
// straight off process.argv the same way every other flag in this file does via arg(). The
// switch is exhaustive over MetricTemplateId with no default arm on purpose: adding a sixth
// template without updating this function is a compile error, not a silent runtime gap.
function metricTemplateParamsFromFlags(template: MetricTemplateId): MetricTemplateFlagResolution {
  switch (template) {
    case "health-sum":
    case "health-avg":
    case "health-count": {
      const kind = arg("--kind");
      return kind ? { params: { template, kind } } : { missingFlag: "--kind" };
    }
    case "spend-by-category": {
      const category = arg("--category");
      return category ? { params: { template, category } } : { missingFlag: "--category" };
    }
    case "spend-by-merchant": {
      const merchantPattern = arg("--merchant-pattern");
      return merchantPattern
        ? { params: { template, merchantPattern } }
        : { missingFlag: "--merchant-pattern" };
    }
  }
}

function formatDoctorCheck(check: DoctorCheck): string {
  return `${check.status.padEnd(4)}  ${check.name}${check.detail ? ` — ${check.detail}` : ""}`;
}

// amount_cents comes back from repo.ts as a bigint-shaped string (postgres.js never widens
// bigint to a JS number, to avoid silent precision loss) — format it as a decimal string using
// only string/integer arithmetic, never a float.
function formatCents(centsStr: string): string {
  const negative = centsStr.startsWith("-");
  const digits = negative ? centsStr.slice(1) : centsStr;
  const padded = digits.padStart(3, "0");
  const whole = padded.slice(0, -2);
  const frac = padded.slice(-2);
  return `${negative ? "-" : ""}${whole}.${frac}`;
}

function padColumns(headers: string[], rows: string[][]): string[] {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const line = (cells: string[]) =>
    cells
      .map((c, i) => c.padEnd(widths[i]!))
      .join("  ")
      .trimEnd();
  return [line(headers), ...rows.map(line)];
}

// Translates the owner's `audit --verb` glob filter into a parameterized SQL LIKE pattern: '*'
// becomes '%' (Postgres's any-run wildcard). Any literal '%'/'_'/'\' in the glob is escaped first
// so only the caller's own '*' behaves specially — mirrors repo.ts's tier0CliEscapeLikePattern for
// the tx/health --match filter. Verbs never actually contain these characters today, but a
// mistyped filter should search literally rather than surprise-matching everything.
function verbLikePattern(glob: string): string {
  return glob.replace(/[\\%_]/g, (ch) => `\\${ch}`).replace(/\*/g, "%");
}

// `audit --summary`'s renderer (W4-11). Prints exactly three tables plus a footer, touching only
// the fixed fields AuditSummary exposes (actor/verb/count, provider/route_tier/count,
// at/verb/actor/request_id/minutes) — never a raw payload object — so there is nothing here for a
// future edit to accidentally widen into a payload dump.
function renderAuditSummary(summary: AuditSummary, days: number): string[] {
  const lines: string[] = [];
  lines.push(`== audit summary: last ${days}d (since ${summary.since.toISOString()}) ==`, "");
  lines.push("-- events by actor/verb --");
  lines.push(
    ...padColumns(
      ["actor", "verb", "count"],
      summary.actorVerbCounts.map((r) => [r.actor, r.verb, String(r.count)]),
    ),
    "",
  );
  lines.push("-- egress rollup (provider / route_tier) --");
  lines.push(
    ...padColumns(
      ["provider", "route_tier", "count"],
      summary.egressRollup.map((r) => [
        r.provider,
        r.routeTier === null ? "-" : String(r.routeTier),
        String(r.count),
      ]),
    ),
    "",
  );
  lines.push("-- unlock history: requested/approved, last 20 --");
  lines.push(
    ...padColumns(
      ["at", "verb", "actor", "request_id", "minutes"],
      summary.unlockHistory.map((r) => [
        r.at.toISOString(),
        r.verb,
        r.actor,
        r.requestId,
        String(r.minutes),
      ]),
    ),
    "",
  );
  lines.push(
    `-- ${summary.totalEvents} events, ${summary.distinctActors} distinct actor(s), ` +
      `${summary.egressEventCount} egress event(s) in last ${days}d --`,
  );
  return lines;
}

const TIER0_TTY_ERROR = "ERROR: tier-0 rows can only print to a real interactive terminal";
const TIER0_TTY_FIX =
  "FIX: run this command directly in a terminal — it refuses to be piped, redirected, or captured";

/**
 * The one function in this file allowed to print tier-0 row content (transactions/health_samples
 * fields) to stdout — the owner-terminal tier-0 read surface (DECISIONS.md 2026-08-10), a
 * recorded, narrowly-scoped exception to CLAUDE.md's "never log, print, or snapshot tier-0
 * contents". Refuses outright unless stdout is a real interactive terminal, so an agent Bash
 * session piping or capturing this command's output gets a refusal, never rows — the gate lives
 * here, first line, so no future call site can reach the print loop without passing it.
 * MINIME_ALLOW_NON_TTY_TIER0=1 is a test-only seam (bun test spawns children with piped stdout,
 * which is never a TTY) — never set it in the owner's real environment, and it must never be
 * documented as anything but test-only.
 */
function renderTier0Lines(lines: string[]): void {
  if (!process.stdout.isTTY && process.env.MINIME_ALLOW_NON_TTY_TIER0 !== "1") {
    throw new Error("tier0_requires_tty");
  }
  for (const line of lines) console.log(line);
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

const CAPTURE_UNAVAILABLE = "[archive unavailable]";

export interface ReviewQueueSummary {
  id: string;
  kind: "inbox_unfiled" | "duplicate";
  inbox_item_id: string | null;
  type: string | null;
  confidence: number | null;
  reason: string;
  text: string;
  candidate_title?: string;
  existing_task_id?: string;
  existing_title?: string;
  score?: number;
}

// Secondary no-unlock read path (W2-2): the owner's own CLI, run locally, needs no tier-2
// unlock ceremony — unlike the MCP tool (src/mcp/tools/review-queue.ts), which masks reason/
// text behind minime_unlock because an agent connection may not be the owner. Exported so
// tests can call it directly instead of spawning a subprocess.
export async function reviewQueueSummaries(): Promise<ReviewQueueSummary[]> {
  const out: ReviewQueueSummary[] = [];
  for (const kind of ["inbox_unfiled", "duplicate"] as const) {
    for (const item of await openReviewItems(kind)) {
      const inboxItemId =
        typeof item.payload?.inbox_item_id === "string" ? item.payload.inbox_item_id : null;
      const inboxItem = inboxItemId ? await getInboxItem(inboxItemId) : null;
      const guess = inboxItem ? storedClassification(inboxItem.classifier_output) : null;
      const text = inboxItem ? await readArchivedCapture(inboxItem) : null;
      out.push({
        id: String(item.id),
        kind,
        inbox_item_id: inboxItemId,
        type: guess?.type ?? null,
        confidence: guess?.confidence ?? null,
        reason: guess?.reason ?? "",
        text: text ?? CAPTURE_UNAVAILABLE,
        ...(kind === "duplicate"
          ? {
              candidate_title:
                typeof item.payload?.candidate_title === "string"
                  ? item.payload.candidate_title
                  : undefined,
              existing_task_id:
                typeof item.payload?.existing_task_id === "string"
                  ? item.payload.existing_task_id
                  : undefined,
              existing_title:
                typeof item.payload?.existing_title === "string"
                  ? item.payload.existing_title
                  : undefined,
              score: typeof item.payload?.score === "number" ? item.payload.score : undefined,
            }
          : {}),
      });
    }
  }
  return out;
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
  // Ahead of the ollamaPreflight gate below (like backup:pre-update): doctor must be able to
  // REPORT Ollama being unreachable as one line among several, not die before printing anything.
  if (cmd === "doctor") {
    const { checks, exitCode } = await runDoctorChecks();
    for (const check of checks) console.log(formatDoctorCheck(check));
    return exitCode;
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
  // Unlock lifecycle continuation (W4-12): status/revoke, owner-terminal-only like unlock:approve
  // just above and placed ahead of the same ollamaPreflight gate below, so checking or closing a
  // tier-2 unlock works even when Ollama is down. Kept strictly before the "tx list" handler's own
  // start marker: test/tier0-cli-read.test.ts's source-slice check (7) scans from that marker to
  // the ollamaPreflight line and asserts no console.log call appears there outside
  // renderTier0Lines — these two commands print freely (request id/minutes/timestamps only, never
  // tier-0 content), so they must stay upstream of that marker, not downstream of it.
  if (cmd === "unlock:status") {
    if (process.argv.length !== 3) {
      console.error("ERROR: unlock:status takes no arguments");
      console.error("FIX: run `bun run src/cli.ts unlock:status` on its own");
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
    const unlocks = await withAdminDbTransaction(() => pendingAndActiveUnlocks());
    if (unlocks.length === 0) {
      console.log("no pending or active tier-2 unlocks");
      return 0;
    }
    for (const u of unlocks) {
      if (u.status === "active") {
        console.log(
          `${u.id}  active   requested_by=${u.requestedBy}  ${u.remainingMinutes}min remaining ` +
            `(of ${u.requestedMinutes}min, expires ${u.expiresAt.toISOString()})`,
        );
      } else {
        const ageMinutes = Math.max(0, Math.floor((Date.now() - u.requestedAt.getTime()) / 60_000));
        console.log(
          `${u.id}  pending  requested_by=${u.requestedBy}  ${u.requestedMinutes}min requested, ` +
            `${ageMinutes}min ago`,
        );
      }
    }
    console.log(`-- ${unlocks.length} pending/active tier-2 unlock(s)`);
    return 0;
  }
  if (cmd === "unlock:revoke") {
    const requestArg = process.argv[3];
    const isAll = requestArg === "--all";
    const isUuid =
      typeof requestArg === "string" &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestArg);
    if (!requestArg || process.argv.length !== 4 || !(isUuid || isAll)) {
      console.error("ERROR: unlock:revoke requires exactly one <request-id>, or --all");
      console.error("FIX: run `bun run src/cli.ts unlock:status` to find an active id");
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
    const revoked = await withAdminDbTransaction(() =>
      revokeTier2Unlock(isAll ? undefined : requestArg),
    );
    if (revoked.length === 0) {
      if (isAll) {
        console.log("no active tier-2 unlocks to revoke");
        return 0;
      }
      console.error("ERROR: that request has no active tier-2 unlock to revoke");
      console.error(
        "FIX: run `bun run src/cli.ts unlock:status` to check what is currently active",
      );
      return 1;
    }
    for (const r of revoked) {
      console.log(
        `revoked tier-2 request ${r.id} (${r.minutes}min, requested by ${r.requestedBy})`,
      );
    }
    return 0;
  }
  // Owner-terminal-only demotion path (W4-2): never reachable through MCP — demotion approval
  // lives here, not in agent-facing tool surface (DECISIONS.md 2026-08-09). Placed ahead of the
  // ollamaPreflight gate below, same as unlock:approve, so --list works without Ollama running.
  if (cmd === "entity:restore-tier") {
    if (process.argv[3] === "--list") {
      if (process.argv.length !== 4) {
        console.error("ERROR: entity:restore-tier --list takes no further arguments");
        console.error("FIX: run `bun run src/cli.ts entity:restore-tier --list` on its own");
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
      // Admin-scope wrap (review finding, 2026-08-09): pendingEntityPromotions() reads
      // people/orgs directly by id with no tier predicate of its own, relying on RLS. Every
      // entity_promotion item points at a tier-2 identity, so on the restricted minime_app role
      // (an ordinary installed deployment's default runtimePool) app_allowed_tier() is locked at
      // 1 absent a live unlock and every row lookup is silently dropped — mirror the restore
      // action's own wrap immediately below so this runs on the owner connection instead.
      const pending = await withAdminDbTransaction(() => pendingEntityPromotions());
      for (const item of pending) {
        const ageMinutes = Math.max(
          0,
          Math.floor((Date.now() - item.createdAt.getTime()) / 60_000),
        );
        console.log(
          `${item.id}  [${item.entityType}]  ${item.entityId}  ${item.name}  flagged ${ageMinutes}min ago`,
        );
      }
      console.log(`-- ${pending.length} pending entity_promotion item(s)`);
      return 0;
    }

    const kindArg = process.argv[3];
    const idArg = process.argv[4];
    const isEntityKind = kindArg === "person" || kindArg === "org";
    const isUuid =
      typeof idArg === "string" &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(idArg);
    if (!isEntityKind || !isUuid || process.argv.length !== 5) {
      console.error("ERROR: entity:restore-tier requires <person|org> <id>, or --list");
      console.error(
        "FIX: run `bun run src/cli.ts entity:restore-tier --list` to find a pending id",
      );
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
      const kind = kindArg as EntityKind;
      const result = await withAdminDbTransaction(() => restoreEntityTier(kind, idArg));
      console.log(`restored ${result.entityType} ${result.entityId} to tier 1`);
      console.log(
        "NOTE: only this identity's own tier changed — any alias or graph edge minted by a " +
          "tier-2 extraction about it stays tier 2.",
      );
      console.log(
        result.resolvedReviewItemId
          ? `resolved review item ${result.resolvedReviewItemId}`
          : "no matching open entity_promotion review item was found",
      );
      return 0;
    } catch (error) {
      if (error instanceof Error && error.message === "entity_not_found") {
        console.error("ERROR: no such person/org id");
        console.error(
          "FIX: run `bun run src/cli.ts entity:restore-tier --list` to find a pending id",
        );
        return 1;
      }
      if (error instanceof Error && error.message === "entity_not_tier_two") {
        console.error("ERROR: that identity is not currently at tier 2");
        console.error(
          "FIX: nothing to restore — it is already tier 1, or tier-0 quarantined and not eligible",
        );
        return 1;
      }
      throw error;
    }
  }
  // Owner-terminal-only vetted-template metric creation (W4-8): never reachable through MCP —
  // metric_defs is owner-curated, minime_app has SELECT only (007_rls.sql:44). Placed ahead of
  // the ollamaPreflight gate below, same as unlock:approve/entity:restore-tier, so it works
  // without Ollama running. There is deliberately no --sql flag: every generated agg_sql comes
  // from one of src/util/metric-templates.ts's five fixed skeletons. (Kept ahead of the tx/health
  // list handlers below, not after them, so test/tier0-cli-read.test.ts's source-slice check that
  // only renderTier0Lines ever prints between those two handlers stays about tx/health alone.)
  if (cmd === "metric:add") {
    const name = arg("--name");
    const templateArg = arg("--template");
    const unit = arg("--unit");
    const description = arg("--description");
    if (!name || !templateArg || !unit) {
      console.error("ERROR: --name, --template, and --unit are required");
      console.error(
        `FIX: metric:add --name <name> --template <${METRIC_TEMPLATE_IDS.join("|")}> --unit <unit> ...`,
      );
      return 2;
    }
    if (!isMetricTemplateId(templateArg)) {
      console.error(`ERROR: --template must be one of: ${METRIC_TEMPLATE_IDS.join(", ")}`);
      console.error("FIX: free-form SQL is migration-only — there is no --sql flag");
      return 2;
    }
    const resolved = metricTemplateParamsFromFlags(templateArg);
    if ("missingFlag" in resolved) {
      console.error(`ERROR: ${resolved.missingFlag} is required for --template ${templateArg}`);
      console.error(`FIX: pass ${resolved.missingFlag} <value>`);
      return 2;
    }
    let generated: ReturnType<typeof generateMetricTemplate>;
    try {
      generated = generateMetricTemplate(resolved.params);
    } catch (error) {
      if (error instanceof Error && error.message === "metric_template_value_invalid") {
        console.error("ERROR: template value contains characters outside the allowed set");
        console.error("FIX: use letters, numbers, spaces, and '_.-' only, 1-64 characters");
        return 2;
      }
      throw error;
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
      await withAdminDbTransaction(() =>
        insertMetricDef({
          name,
          unit,
          description: description ?? METRIC_TEMPLATE_DEFAULT_DESCRIPTION[templateArg],
          aggSql: generated.aggSql,
          rollup: generated.rollup,
        }),
      );
    } catch (error) {
      if (error instanceof Error && error.message === "metric_name_invalid") {
        console.error("ERROR: --name must be lowercase snake_case");
        console.error("FIX: pass a name matching /^[a-z][a-z0-9_]{1,63}$/, e.g. dining_spend");
        return 2;
      }
      if (error instanceof Error && error.message === "metric_name_exists") {
        console.error(`ERROR: a metric named '${name}' already exists`);
        console.error("FIX: choose a different --name, or query the existing metric");
        return 1;
      }
      console.error("ERROR: the generated metric failed its dry run and was not saved");
      console.error(`FIX: ${error instanceof Error ? error.message : String(error)}`);
      return 1;
    }
    // Audited only on success (mirrors tx/health list's own ordering) — a rejected value or
    // duplicate name never reached the database, so there is nothing to leave a trail for.
    await logEvent({
      actor: "owner:cli",
      verb: "cli:metric:add",
      payload: auditPayload.cliMetricAdd({ metric: name, template: templateArg }),
    });
    console.log(`created metric '${name}' (template=${templateArg}, rollup=${generated.rollup})`);
    return 0;
  }
  // Owner-terminal-only tier-0 read surface (W4-5): never reachable through MCP — see the
  // section header above listTransactions/listHealthSamples (src/db/repo.ts) and
  // renderTier0Lines above. Placed ahead of the ollamaPreflight gate below, same as
  // unlock:approve/entity:restore-tier, so reads work without Ollama running.
  if (cmd === "tx" && process.argv[3] === "list") {
    const month = arg("--month");
    const match = arg("--match");
    const limitArg = arg("--limit");
    if (!month) {
      console.error("ERROR: --month is required");
      console.error("FIX: pass --month YYYY-MM, e.g. tx list --month 2026-08");
      return 2;
    }
    let limit: number | undefined;
    if (limitArg !== undefined) {
      limit = Number(limitArg);
      if (!Number.isSafeInteger(limit) || limit < 1) {
        console.error("ERROR: --limit must be a positive integer");
        console.error("FIX: pass e.g. --limit 50");
        return 2;
      }
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
    let rows: Tier0TransactionRow[];
    try {
      rows = await withAdminDbTransaction(() => listTransactions({ month, match, limit }));
    } catch (error) {
      if (error instanceof Error && error.message === "month_invalid") {
        console.error("ERROR: --month must look like YYYY-MM");
        console.error("FIX: pass e.g. --month 2026-08");
        return 2;
      }
      throw error;
    }
    // Audited before the TTY-gated render below runs: "every invocation" (spec) means every
    // real read, whether or not the terminal check afterward lets it actually print — a piped
    // attempt still leaves a count-only forensic trace, it just never sees the rows.
    await logEvent({
      actor: "owner:cli",
      verb: "cli:tx:list",
      payload: auditPayload.cliTxList({
        month,
        rowCount: rows.length,
        matchUsed: match !== undefined,
      }),
    });
    const lines = padColumns(
      ["date", "amount", "currency", "merchant", "category"],
      rows.map((r) => [
        r.occurredAt,
        formatCents(r.amountCents),
        r.currency,
        r.merchant ?? "",
        r.category ?? "",
      ]),
    );
    lines.push(`-- ${rows.length} transaction(s)`);
    try {
      renderTier0Lines(lines);
    } catch (error) {
      if (error instanceof Error && error.message === "tier0_requires_tty") {
        console.error(TIER0_TTY_ERROR);
        console.error(TIER0_TTY_FIX);
        return 4;
      }
      throw error;
    }
    return 0;
  }
  if (cmd === "health" && process.argv[3] === "list") {
    const kind = arg("--kind");
    const from = arg("--from");
    const to = arg("--to");
    const limitArg = arg("--limit");
    if (!kind) {
      console.error("ERROR: --kind is required");
      console.error("FIX: pass --kind <kind>, e.g. health list --kind steps");
      return 2;
    }
    let limit: number | undefined;
    if (limitArg !== undefined) {
      limit = Number(limitArg);
      if (!Number.isSafeInteger(limit) || limit < 1) {
        console.error("ERROR: --limit must be a positive integer");
        console.error("FIX: pass e.g. --limit 50");
        return 2;
      }
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
    let rows: Tier0HealthSampleRow[];
    try {
      rows = await withAdminDbTransaction(() => listHealthSamples({ kind, from, to, limit }));
    } catch (error) {
      if (error instanceof Error && error.message === "kind_invalid") {
        console.error("ERROR: --kind is invalid");
        console.error("FIX: pass a lowercase snake_case kind, e.g. --kind sleep_minutes");
        return 2;
      }
      if (
        error instanceof Error &&
        (error.message === "from_invalid" || error.message === "to_invalid")
      ) {
        const flag = error.message === "from_invalid" ? "--from" : "--to";
        console.error(`ERROR: ${flag} must be a real calendar date, YYYY-MM-DD`);
        console.error("FIX: pass e.g. --from 2026-08-01 --to 2026-08-31");
        return 2;
      }
      throw error;
    }
    // Same ordering rationale as tx list above: audited before the render gate, not after.
    await logEvent({
      actor: "owner:cli",
      verb: "cli:health:list",
      payload: auditPayload.cliHealthList({
        kind,
        rowCount: rows.length,
        matchUsed: false, // health list has no --match flag today
      }),
    });
    const lines = padColumns(
      ["at", "kind", "value", "unit"],
      rows.map((r) => [r.at, r.kind, r.value, r.unit]),
    );
    lines.push(`-- ${rows.length} health sample(s)`);
    try {
      renderTier0Lines(lines);
    } catch (error) {
      if (error instanceof Error && error.message === "tier0_requires_tty") {
        console.error(TIER0_TTY_ERROR);
        console.error(TIER0_TTY_FIX);
        return 4;
      }
      throw error;
    }
    return 0;
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
      const schedule = await startOwnerMaintenanceSchedule();
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
    case "review": {
      const summaries = await reviewQueueSummaries();
      for (const s of summaries) {
        const guess = s.type
          ? `${s.type} (${(s.confidence ?? 0).toFixed(2)})`
          : "no classifier guess";
        console.log(`${s.id}  [${s.kind}]  ${guess}`);
        if (s.reason) console.log(`  reason: ${s.reason}`);
        if (s.kind === "duplicate") {
          console.log(`  candidate: ${s.candidate_title ?? ""}`);
          console.log(
            `  matches existing task ${s.existing_task_id ?? ""}: ${s.existing_title ?? ""}`,
          );
        }
        console.log(`  text: ${s.text}`);
        console.log("");
      }
      console.log(`-- ${summaries.length} open item(s) awaiting review`);
      return 0;
    }
    case "audit": {
      const since = arg("--since") ?? "7d";
      const days = Number(since.match(/^(\d+)d$/)?.[1] ?? 7);
      const sinceDate = new Date(Date.now() - days * 86_400_000);
      if (process.argv.includes("--summary")) {
        const summary = await auditSummarySince(sinceDate);
        for (const line of renderAuditSummary(summary, days)) console.log(line);
        return 0;
      }
      const verbGlob = arg("--verb");
      const actor = arg("--actor");
      const rows = await eventsSince(sinceDate, {
        verbLike: verbGlob === undefined ? undefined : verbLikePattern(verbGlob),
        actor,
      });
      for (const r of rows) {
        const p = r.payload ?? {};
        const ids =
          Array.isArray(p.returned_ids) && p.returned_ids.length
            ? ` ids=${p.returned_ids.length}`
            : "";
        // cli:tx:list / cli:health:list (W4-5): the only payload shape carrying `row_count` —
        // surfaces the month/kind, count, and whether a match filter was used, exactly what
        // docs/GUIDE.md promises `minime audit` shows for these two verbs. Never the match text
        // or any row content: the payload never carries either, so there is nothing here to leak.
        const tier0Count =
          typeof p.row_count === "number"
            ? ` ${p.month !== undefined ? `month=${p.month}` : `kind=${p.kind}`} count=${p.row_count} match_used=${p.match_used}`
            : "";
        console.log(
          `${new Date(r.at).toISOString()}  ${r.actor.padEnd(24)} ${r.verb}${ids}${tier0Count}${p.error ? ` ERROR=${p.error}` : ""}`,
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

// Guarded so importing this module for an export (e.g. reviewQueueSummaries, tested
// function-level rather than via subprocess) never runs the CLI or exits the process;
// `bun run src/cli.ts <command>` is the only path where this file is the entry point.
if (import.meta.main) {
  const code = await main();
  if (code >= 0) {
    await closeDb();
    process.exit(code);
  }
}
