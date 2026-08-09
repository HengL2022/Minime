// W3-11: local push channel for a counts-only morning-brief notification, opt-in via
// BRIEF_CRON (empty = disabled, src/util/config.ts). Two hard rules mirror the codebase's
// existing local-only patterns:
//   1. COUNTS ONLY. buildBriefText renders five fixed counts and a fixed maintenance word off
//      stateSnapshot()/opsHealth() (W3-7) -- never a row title, question, or name -- because the
//      rendered text can land on a lock screen. It reads only `.length`/numeric fields off the
//      snapshot, so it cannot leak content regardless of what stateSnapshot() otherwise carries.
//   2. LOCAL DELIVERY ONLY (I1). The OS notifier (osascript on darwin, notify-send on linux) is
//      a local subprocess spawned via an execv array, never a shell string. The optional NTFY_URL
//      fallback is validated to an exact loopback literal at config load (fail closed), so this
//      never becomes a new external network dependency.
import { config } from "../util/config";

export interface BriefSnapshot {
  calendar: readonly unknown[];
  tasks_due: readonly unknown[];
  decision_reviews_due: readonly unknown[];
  review_queue_open: number;
  upcoming_dates: readonly unknown[];
  ops_health: { failed_steps: readonly string[] };
}

export interface BriefCounts {
  events: number;
  tasksDue: number;
  decisionReviews: number;
  reviewItems: number;
  upcomingDates: number;
  maintenanceOk: boolean;
}

/** The six counts the brief ever renders or audits -- pure, no row content ever touched. */
export function briefCounts(snapshot: BriefSnapshot): BriefCounts {
  return {
    events: snapshot.calendar.length,
    tasksDue: snapshot.tasks_due.length,
    decisionReviews: snapshot.decision_reviews_due.length,
    reviewItems: snapshot.review_queue_open,
    upcomingDates: snapshot.upcoming_dates.length,
    maintenanceOk: snapshot.ops_health.failed_steps.length === 0,
  };
}

/**
 * Fixed counts-only template -- numbers and fixed words only, zero row content, because this
 * renders on lock screens: "Minime: N events today, M tasks due, K decision reviews, R review
 * items, D upcoming dates; maintenance OK/failed(steps)". `failed_steps` is the same fixed,
 * closed dream-step-identifier vocabulary audit-payload.ts's dreamSummary already allows onto
 * minime_state's ops_health block (W3-7) -- never free text.
 */
export function buildBriefText(snapshot: BriefSnapshot): string {
  const c = briefCounts(snapshot);
  const maintenance = c.maintenanceOk
    ? "OK"
    : `failed(${snapshot.ops_health.failed_steps.join(",")})`;
  return (
    `Minime: ${c.events} events today, ${c.tasksDue} tasks due, ` +
    `${c.decisionReviews} decision reviews, ${c.reviewItems} review items, ` +
    `${c.upcomingDates} upcoming dates; maintenance ${maintenance}`
  );
}

export interface BriefDelivery {
  ok: boolean;
}

// Test-only override: replaces the whole delivery attempt (osascript/notify-send/ntfy) so
// `bun test` never spawns a real OS notification or makes a real HTTP call. Mirrors
// pipeline/backup.ts's __setCommandRunnerForTest.
let deliverForTest: ((text: string) => Promise<BriefDelivery>) | undefined;
export function __setDeliverForTest(
  fn: ((text: string) => Promise<BriefDelivery>) | undefined,
): void {
  deliverForTest = fn;
}

async function runCommand(cmd: string[]): Promise<boolean> {
  try {
    // execv array, never a shell string -- see escapeAppleScriptString below for why that
    // still matters even here (osascript's own -e argument is itself a small script language).
    const proc = Bun.spawn(cmd, { stdout: "ignore", stderr: "ignore" });
    return (await proc.exited) === 0;
  } catch {
    return false;
  }
}

// AppleScript string-literal escaping for the one place buildBriefText's output is embedded in
// a larger command string. buildBriefText only ever emits fixed words/digits/punctuation, so
// this is defense in depth, not a load-bearing sanitizer against untrusted content.
function escapeAppleScriptString(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

async function osascriptNotify(text: string): Promise<boolean> {
  if (!Bun.which("osascript")) return false;
  const script = `display notification "${escapeAppleScriptString(text)}" with title "Minime"`;
  return runCommand(["osascript", "-e", script]);
}

async function notifySendNotify(text: string): Promise<boolean> {
  if (!Bun.which("notify-send")) return false;
  return runCommand(["notify-send", "Minime", text]);
}

const NTFY_TIMEOUT_MS = 10_000;

async function ntfyNotify(text: string): Promise<boolean> {
  if (!config.ntfyUrl) return false;
  try {
    const res = await fetch(config.ntfyUrl, {
      method: "POST",
      body: text,
      headers: { Title: "Minime" },
      // config.ntfyUrl is already loopback-validated at config load; refusing redirects keeps
      // every hop local too (same discipline as search/rerank.ts's reranker call).
      redirect: "error",
      signal: AbortSignal.timeout(NTFY_TIMEOUT_MS),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Attempt every applicable local channel: the platform OS notifier (darwin osascript / linux
 * notify-send) and, independently, the optional loopback ntfy POST. Each is best-effort and
 * both fire when available rather than the second being a fallback for the first -- they are
 * different destinations (this machine's desktop vs. a subscribed phone), not redundant copies
 * of the same one. Delivered (ok: true) once at least one channel actually succeeded.
 */
export async function deliverBrief(text: string): Promise<BriefDelivery> {
  if (deliverForTest) return deliverForTest(text);
  let delivered = false;
  if (process.platform === "darwin") delivered = (await osascriptNotify(text)) || delivered;
  if (process.platform === "linux") delivered = (await notifySendNotify(text)) || delivered;
  delivered = (await ntfyNotify(text)) || delivered;
  return { ok: delivered };
}
