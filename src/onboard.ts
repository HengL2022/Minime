// First-run onboarding interview (owner-facing, spec §0 spirit: the database is only as
// useful as what's in it). A ~5-minute guided Q&A that seeds the owner's basics — who they
// are, values, goals, principles, key people, current projects, an opening journal entry —
// through the same repo.ts write paths agents use. Everything is optional (Enter skips),
// everything is editable later, nothing ever leaves the machine. Rows stamp
// source='onboard', created_by='human' so the interview's contribution stays auditable
// (I5; DECISIONS.md 2026-06-12). Re-running adds rows, it never overwrites.

import readline from "node:readline";
import {
  ensurePerson,
  insertGoal,
  insertJournal,
  insertPrinciple,
  insertValueItem,
  logEvent,
  setPersonDetails,
  upsertPage,
  upsertTask,
  valuesCount,
} from "./db/repo";
import { indexParent } from "./search/index-parent";
import { todayStr } from "./util/clock";

const SOURCE = "onboard";
const ACTOR = "human";

interface IO {
  ask: (q: string) => Promise<string>;
  say: (s: string) => void;
}

async function askLoop(io: IO, prompt: string, max: number): Promise<string[]> {
  const out: string[] = [];
  while (out.length < max) {
    const a = (
      await io.ask(
        `  ${prompt} ${out.length + 1}${out.length === 0 ? "" : " (Enter to move on)"}: `,
      )
    ).trim();
    if (!a) break;
    out.push(a);
  }
  return out;
}

async function sectionAboutYou(io: IO): Promise<number> {
  io.say("\n— About you —");
  const name = (await io.ask("  Your name: ")).trim();
  const work = (await io.ask("  What do you do (work, study, …)? ")).trim();
  const where = (await io.ask("  Where do you live? ")).trim();
  const extra = (
    await io.ask("  Anything else an assistant should always know about you? ")
  ).trim();
  const facts = [
    name && `- Name: ${name}`,
    work && `- Occupation: ${work}`,
    where && `- Location: ${where}`,
    extra && `- Notes: ${extra}`,
  ].filter(Boolean);
  if (facts.length === 0) return 0;
  const title = name ? `About ${name}` : "About me";
  const body = `# ${title}\n\nOwner profile, captured during onboarding (${todayStr()}).\n\n${facts.join("\n")}\n`;
  const hash = new Bun.CryptoHasher("sha256").update(body).digest("hex");
  const { id } = await upsertPage({
    path: "me/about.md",
    title,
    bodyMd: body,
    contentHash: hash,
    createdBy: ACTOR,
    source: SOURCE,
  });
  await indexParent("page", id, body, title, 1);
  return 1;
}

async function sectionValues(io: IO): Promise<number> {
  io.say("\n— Values — what matters most to you, in order. Agents weigh advice against these.");
  const values = await askLoop(io, "Value", 5);
  let p = 1;
  for (const statement of values) {
    await insertValueItem({ statement, priority: p++, createdBy: ACTOR, source: SOURCE });
  }
  return values.length;
}

async function sectionGoals(io: IO): Promise<number> {
  io.say("\n— Goals — long arcs first, then this year.");
  let n = 0;
  for (const g of await askLoop(io, "Life goal", 3)) {
    await insertGoal({ horizon: "life", statement: g, createdBy: ACTOR, source: SOURCE });
    n++;
  }
  for (const g of await askLoop(io, "This year's goal", 5)) {
    await insertGoal({ horizon: "year", statement: g, createdBy: ACTOR, source: SOURCE });
    n++;
  }
  return n;
}

async function sectionPrinciples(io: IO): Promise<number> {
  io.say(
    '\n— Principles — rules you\'ve learned to live or work by. (e.g. "sleep before deciding")',
  );
  const rules = await askLoop(io, "Principle", 5);
  for (const rule of rules) {
    await insertPrinciple({ rule, createdBy: ACTOR, source: SOURCE });
  }
  return rules.length;
}

async function sectionPeople(io: IO): Promise<number> {
  io.say(
    '\n— Key people — the handful who matter day to day. Relation is from your side: "my wife", "my manager", "my GP".',
  );
  let n = 0;
  for (;;) {
    const name = (
      await io.ask(`  Person ${n + 1} name${n === 0 ? "" : " (Enter to move on)"}: `)
    ).trim();
    if (!name) break;
    const relation = (await io.ask('    relation ("my …"): ')).trim();
    const context = (await io.ask("    one line of context: ")).trim();
    const { id } = await ensurePerson(name, ACTOR, SOURCE);
    await setPersonDetails(id, relation || null, context || null);
    n++;
  }
  return n;
}

async function sectionProjects(io: IO): Promise<number> {
  io.say("\n— Current projects & tasks — what's on your plate right now.");
  let n = 0;
  for (;;) {
    const title = (
      await io.ask(`  Task/project ${n + 1}${n === 0 ? "" : " (Enter to move on)"}: `)
    ).trim();
    if (!title) break;
    const dueRaw = (await io.ask("    due date YYYY-MM-DD (Enter for none): ")).trim();
    const due = /^\d{4}-\d{2}-\d{2}$/.test(dueRaw) ? dueRaw : null;
    const { id } = await upsertTask({ title, due, createdBy: ACTOR, source: SOURCE });
    await indexParent("task", id, title, title, 1);
    n++;
  }
  return n;
}

async function sectionSnapshot(io: IO): Promise<number> {
  io.say(
    "\n— Snapshot — a few sentences on where life is right now. Becomes your first journal entry (tier 2: private, unlock-gated).",
  );
  const text = (await io.ask("  Today: ")).trim();
  if (!text) return 0;
  const { id } = await insertJournal({ entryMd: text, createdBy: ACTOR, source: SOURCE });
  await indexParent("journal", id, text, `Journal ${todayStr()}`, 2);
  return 1;
}

export async function onboard(
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
): Promise<Record<string, number>> {
  const rl = readline.createInterface({ input, output });
  // Lines are buffered as they arrive rather than requested one question at a time, so
  // piped answer files work and EOF (Ctrl-D, or the pipe running dry) means "skip the
  // rest" instead of an ERR_USE_AFTER_CLOSE crash mid-interview.
  const pending: string[] = [];
  const waiters: ((s: string) => void)[] = [];
  let closed = false;
  rl.on("line", (l) => {
    const w = waiters.shift();
    if (w) w(l);
    else pending.push(l);
  });
  rl.on("close", () => {
    closed = true;
    for (const w of waiters.splice(0)) w("");
  });
  const io: IO = {
    ask: (q) => {
      output.write(q);
      if (pending.length > 0) return Promise.resolve(pending.shift()!);
      if (closed) return Promise.resolve("");
      return new Promise((resolve) => waiters.push(resolve));
    },
    say: (s) => output.write(`${s}\n`),
  };
  try {
    io.say("Minime onboarding — a 5-minute interview to seed your database.");
    io.say(
      "Everything stays on this machine. Enter skips any question; re-run anytime (adds, never overwrites).",
    );
    if ((await valuesCount()) > 0) {
      io.say(
        "note: this database already has values/goals — new answers will be ADDED alongside them.",
      );
    }
    const counts: Record<string, number> = {};
    counts.profile = await sectionAboutYou(io);
    counts.values = await sectionValues(io);
    counts.goals = await sectionGoals(io);
    counts.principles = await sectionPrinciples(io);
    counts.people = await sectionPeople(io);
    counts.tasks = await sectionProjects(io);
    counts.journal = await sectionSnapshot(io);

    await logEvent({ actor: ACTOR, verb: "onboard:complete", payload: counts });
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    io.say(`\nDone — ${total} entries seeded: ${JSON.stringify(counts)}`);
    io.say("Next: `bun run src/cli.ts serve`, then ask your agent for a morning brief.");
    io.say("Guide: docs/GUIDE.md · capture anything by dropping text into data/inbox/");
    return counts;
  } finally {
    rl.close();
  }
}
