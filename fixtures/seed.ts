// Fictional demo dataset (spec §7/§14: realistic but NEVER the owner's real data).
// Persona: "Alex Tan", Singapore. Dates are relative to seed time so the demo stays current.
// Used by tests and the M3 retrieval eval.

import {
  ensurePerson,
  insertCommitment,
  insertDecision,
  insertGoal,
  insertHealthSample,
  insertInteraction,
  insertJournal,
  insertPrinciple,
  insertTransaction,
  insertValueItem,
  listActivePages,
  upsertCalendarEvent,
  upsertPage,
  upsertTask,
} from "../src/db/repo";
import { entityLinkPass } from "../src/pipeline/dream";
import { drainEmbedBacklog, indexParent } from "../src/search/index-parent";
import { now } from "../src/util/clock";

const day = 86_400_000;
const daysAgo = (n: number) => new Date(now().getTime() - n * day);
const daysAhead = (n: number) => new Date(now().getTime() + n * day);
const dateStr = (d: Date) => d.toISOString().slice(0, 10);

// deterministic PRNG so transaction/health values are stable run-to-run
function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const PEOPLE: { name: string; alias?: string; relation: string; context: string }[] = [
  {
    name: "Mei Lin",
    alias: "Mei",
    relation: "sister",
    context: "Lives in Punggol; two kids; loves pottery",
  },
  {
    name: "Jordan Lee",
    relation: "manager",
    context: "Engineering manager at Lumenworks since 2024",
  },
  {
    name: "Priya Sharma",
    relation: "mentor",
    context: "Former CTO; monthly coffee chats about career",
  },
  {
    name: "Sam Chen",
    alias: "Sammy",
    relation: "best friend",
    context: "Climbing partner; met in university",
  },
  { name: "Dr. Ng", relation: "doctor", context: "GP at Tanjong Pagar clinic" },
  {
    name: "Rafael Ortiz",
    relation: "climbing partner",
    context: "Met at Boulder Movement in 2025",
  },
  { name: "Hana Suzuki", relation: "college friend", context: "Lives in Tokyo; product designer" },
  { name: "Wei Jie", relation: "coworker", context: "Backend engineer on the payments team" },
  { name: "Nadia Rahman", relation: "neighbor", context: "Unit 12-04; waters plants when away" },
  {
    name: "Tom Becker",
    relation: "former colleague",
    context: "Moved to San Francisco in 2023; at a robotics startup",
  },
];

export const PAGES: { path: string; title: string; body: string }[] = [
  {
    path: "travel/tokyo-trip-plan.md",
    title: "Tokyo trip plan",
    body: "# Tokyo trip plan\n\nFive days in Tokyo in autumn. Stay near Shinjuku for train access. Must do: TeamLab Planets, day trip to Kamakura, izakaya night in Golden Gai with Hana Suzuki.\n\nBudget roughly 2400 dollars including flights. Hana recommended the Tsukiji outer market for breakfast and a jazz bar called Pit Inn.",
  },
  {
    path: "hobbies/climbing-log.md",
    title: "Climbing progression log",
    body: "# Climbing progression log\n\nBouldering grade goal: consistent V5 by December. Currently projecting V4 overhangs at Boulder Movement. Sam Chen says my footwork on slab improved a lot.\n\nFingerboard routine twice a week, max hangs 7 seconds on the 20mm edge. Rafael Ortiz suggested open-hand grip drills to protect the pulleys.",
  },
  {
    path: "cooking/sourdough-recipe.md",
    title: "Sourdough starter and bread recipe",
    body: "# Sourdough starter and bread recipe\n\nFeed the starter daily with 50g flour and 50g water; it doubles in about six hours at Singapore room temperature. Bake at 230C in the dutch oven, 20 minutes lid on, 20 off.\n\nHydration 75 percent works best with the local bread flour. Overnight cold retard in the fridge improves the crumb.",
  },
  {
    path: "tech/home-server-setup.md",
    title: "Home server setup",
    body: "# Home server setup\n\nMini PC running Debian in the hall cabinet. Services: Syncthing for phone capture, Postgres for Minime, nightly restic backups to the NAS, Tailscale for remote access.\n\nUPS keeps it alive through short outages. Remember the BIOS auto-restart-on-power setting.",
  },
  {
    path: "reading/reading-list.md",
    title: "Reading list",
    body: "# Reading list\n\nCurrently reading Thinking in Systems by Donella Meadows. Queue: The Pathless Path, How Big Things Get Done, Slow Productivity by Cal Newport.\n\nFinished and loved: Four Thousand Weeks. Priya Sharma recommended High Output Management for the new role.",
  },
  {
    path: "career/career-ladder-notes.md",
    title: "Career ladder notes",
    body: "# Career ladder notes\n\nPromotion to senior engineer requires a system design artifact and cross-team impact. Jordan Lee suggested leading the payments reconciliation project as the showcase.\n\nGap to close: public speaking. Sign up for the internal tech talk series next quarter.",
  },
  {
    path: "food/hawker-favorites.md",
    title: "Singapore hawker favorites",
    body: "# Singapore hawker favorites\n\nMaxwell: Tian Tian chicken rice, but the queue peaks at noon. Amoy Street: char kway teow stall 02-110. Tiong Bahru: shui kueh for breakfast.\n\nLau Pa Sat satay street only after 7pm. Mei says the Punggol hawker centre laksa beats Katong's, which is fighting words.",
  },
  {
    path: "fitness/marathon-training-plan.md",
    title: "Marathon training plan",
    body: "# Marathon training plan\n\nStanchart Singapore Marathon in December. Sixteen week block: easy runs Tuesday and Thursday, long run Sunday morning before the heat.\n\nTarget weekly mileage builds from 30km to 55km. Long run pace 6:30 per km, race goal 4 hours 15. Hydration plan matters more than pace here.",
  },
  {
    path: "money/investing-policy.md",
    title: "Personal investing policy",
    body: "# Personal investing policy\n\nDollar cost average monthly into a global index ETF. Six months expenses as emergency cash in a high-yield savings account. No single stock positions above five percent.\n\nRebalance once a year in January. Never sell in a drawdown; re-read this page before any panic decision.",
  },
  {
    path: "practice/meditation-notes.md",
    title: "Meditation practice notes",
    body: "# Meditation practice notes\n\nTen minutes every morning after coffee, breath counting. Noting practice works better than body scan when restless.\n\nStreak broken twice this quarter; the trigger is late-night screens. Phone charges outside the bedroom now.",
  },
  {
    path: "learning/spanish-progress.md",
    title: "Spanish learning progress",
    body: "# Spanish learning progress\n\nFinished the A2 course. Thirty minute Anki review daily, conversation exchange with a tutor from Medellin on Wednesdays.\n\nGoal: hold a fifteen minute conversation about work by September. Subjunctive remains the boss fight.",
  },
  {
    path: "gear/photography-gear.md",
    title: "Photography gear notes",
    body: "# Photography gear notes\n\nFuji X-T5 with the 23mm f2 for street. Considering the 56mm for portraits — rent before buying.\n\nLightroom preset: classic chrome base, highlights minus 20. Print the best twelve photos each year for the album.",
  },
  {
    path: "home/apartment-renovation.md",
    title: "Apartment renovation ideas",
    body: "# Apartment renovation ideas\n\nKitchen first: replace the laminate counter with quartz, add under-cabinet lighting. Contractor quote from Nadia's recommendation came in at nine thousand.\n\nLiving room built-in bookshelf along the west wall. Defer the bathroom until next year.",
  },
  {
    path: "admin/emergency-contacts.md",
    title: "Emergency contacts and documents",
    body: "# Emergency contacts and documents\n\nPassport renewal due next March. Insurance policies in the fireproof box, scanned copies in the encrypted vault.\n\nIn an emergency call Mei Lin first. Dr. Ng's clinic for non-urgent medical questions.",
  },
  {
    path: "work/payments-reconciliation.md",
    title: "Payments reconciliation project",
    body: "# Payments reconciliation project\n\nDaily ledger diffs between the gateway and our books drift by a few cents on refunds. Root cause: rounding at currency conversion. Wei Jie owns the fix on the settlement side.\n\nMilestone one: automated daily diff report. Milestone two: self-healing for known patterns. Demo to Jordan Lee end of month.",
  },
  {
    path: "hobbies/aquarium-care.md",
    title: "Aquarium care guide",
    body: "# Aquarium care guide\n\nTwenty litre planted tank with cherry shrimp and a betta. Weekly 30 percent water change, dechlorinate before topping up.\n\nKeep nitrates under 20ppm. The almond leaf keeps the betta's fins healthy.",
  },
  {
    path: "travel/bali-surf-trip.md",
    title: "Bali surf trip notes",
    body: "# Bali surf trip notes\n\nUluwatu in the dry season for the reef breaks, Canggu for beginner-friendly beach breaks. Rent boards at the beach, bring reef booties.\n\nStay in Bingin: quiet, cliffside warungs, sunset every night. Scooter helmet always, the traffic is real.",
  },
  {
    path: "cooking/curry-paste.md",
    title: "Rempah curry paste from scratch",
    body: "# Rempah curry paste from scratch\n\nBlend shallots, garlic, galangal, lemongrass, dried chilies soaked in hot water, candlenuts, belacan. Fry low and slow until the oil splits — pecah minyak — about twenty minutes.\n\nFreeze in ice cube trays. One cube per pot of curry or mee rebus.",
  },
  {
    path: "tech/keyboard-build.md",
    title: "Custom keyboard build",
    body: "# Custom keyboard build\n\nSixty five percent board with gateron oil king switches, lubed with krytox. PE foam mod made it too muffled, removed it.\n\nKeymap: caps lock as control-escape dual function. QMK firmware repo on the home server.",
  },
  {
    path: "health/sleep-hygiene.md",
    title: "Sleep hygiene protocol",
    body: "# Sleep hygiene protocol\n\nLights out 23:30, wake 06:45 without alarm on good weeks. No caffeine after 14:00. Aircon at 24 with the fan on low.\n\nReading fiction beats podcasts for falling asleep. Track sleep minutes via the watch and review monthly.",
  },
  {
    path: "work/oncall-runbook.md",
    title: "On-call runbook notes",
    body: "# On-call runbook notes\n\nPage severity one: gateway error rate above two percent for five minutes. First move is the dashboard, then check the last deploy, then the feature flag log.\n\nEscalate to Wei Jie for settlement issues. Postmortems within 48 hours, blameless.",
  },
  {
    path: "family/mei-kids-gifts.md",
    title: "Gift ideas for Mei's kids",
    body: "# Gift ideas for Mei's kids\n\nKai turns seven in August: the snap circuits kit or a beginner microscope. Ling is into dinosaurs and drawing — art supplies plus the pop-up dinosaur encyclopedia.\n\nNo more noisy toys, Mei has formally requested. Experiences over things: Science Centre tickets work.",
  },
  {
    path: "hobbies/chess-openings.md",
    title: "Chess opening repertoire",
    body: "# Chess opening repertoire\n\nWhite: London system for low theory. Black: Caro-Kann against e4, slav against d4.\n\nBlitz rating hovering around 1450. Do tactics puzzles before games, not after losing three in a row.",
  },
  {
    path: "money/tax-checklist.md",
    title: "Annual tax filing checklist",
    body: "# Annual tax filing checklist\n\nFile by April 15. Reliefs to claim: CPF top-up, course fees for the Spanish classes do not qualify, SRS contribution does.\n\nDonation receipts are auto-included. Check employment income is pre-filled before submitting.",
  },
  {
    path: "tech/note-taking-system.md",
    title: "Note-taking system",
    body: "# Note-taking system\n\nEverything captured to the inbox first, processed in the evening. Brain pages in markdown, one topic per file, linked liberally.\n\nWeekly review on Sunday: empty the inbox, review stale pages, plan the week. The system serves recall, not collection.",
  },
  {
    path: "fitness/mobility-routine.md",
    title: "Mobility routine",
    body: "# Mobility routine\n\nTen minutes post-run: couch stretch, pigeon, calf raises on the step. Shoulder dislocates with the band before climbing.\n\nHips are the bottleneck from desk work. Standing desk afternoons only.",
  },
  {
    path: "travel/perth-road-trip.md",
    title: "Perth road trip draft",
    body: "# Perth road trip draft\n\nMargaret River wineries and the karri forests, five days, campervan. Best window is March when the heat breaks.\n\nSwim with the dolphins at Rockingham. Mei wants to join with the kids if school holidays line up.",
  },
  {
    path: "work/feedback-received.md",
    title: "Feedback received log",
    body: "# Feedback received log\n\nFrom Jordan Lee in the March review: strong execution, should delegate more, writing is clear. From Priya: say the uncomfortable thing earlier in meetings.\n\nPattern across years: I under-communicate progress. Weekly update email is the fix.",
  },
  {
    path: "home/plant-care.md",
    title: "Houseplant care schedule",
    body: "# Houseplant care schedule\n\nMonstera by the window: water weekly, wipe leaves monthly. Snake plants survive neglect, water fortnightly. Nadia Rahman waters everything when I travel.\n\nFertilize monthly during the growing season only. Repot the monstera before it eats the living room.",
  },
  {
    path: "learning/woodworking-course.md",
    title: "Woodworking course notes",
    body: "# Woodworking course notes\n\nWeekend course at the makerspace: cut a finger joint box, learned the router table. Sharp chisels are safer than dull ones.\n\nNext project: a walnut serving board. Wood movement is the thing beginners ignore, says the instructor.",
  },
];

export const DECISIONS: {
  question: string;
  options: string[];
  criteria?: string[];
  choice?: string;
  reasoning?: string;
  expected?: string;
  reviewInDays: number;
  decidedDaysAgo?: number;
  outcome?: string;
}[] = [
  {
    question: "Should I take the senior role on the payments team at Lumenworks?",
    options: ["take the role", "stay on current team", "look externally"],
    criteria: ["growth", "manager quality", "scope"],
    choice: "take the role",
    reasoning: "Jordan Lee sponsors it; reconciliation project is the promotion artifact.",
    expected: "Promotion case ready by year end",
    reviewInDays: 90,
    decidedDaysAgo: 40,
  },
  {
    question: "Buy the ergonomic chair or keep the dining chair setup?",
    options: ["buy Aeron used", "buy budget mesh chair", "keep current"],
    choice: "buy Aeron used",
    reasoning: "Back pain after long days; used market price acceptable.",
    expected: "Back pain gone within a month",
    reviewInDays: 30,
    decidedDaysAgo: 45,
    outcome: "Back pain mostly resolved; worth it.",
  },
  {
    question: "Full marathon or half marathon in December?",
    options: ["full marathon", "half marathon"],
    criteria: ["injury risk", "training time"],
    choice: "full marathon",
    reasoning: "Sixteen weeks is enough; long run base exists.",
    expected: "Finish under 4:15 without injury",
    reviewInDays: 120,
    decidedDaysAgo: 20,
  },
  {
    question: "Move to the bigger apartment in Queenstown or renew the lease?",
    options: ["move", "renew one year"],
    choice: "renew one year",
    reasoning: "Rental market still hot; renovation makes current place workable.",
    expected: "Revisit when market cools",
    reviewInDays: 180,
    decidedDaysAgo: 60,
  },
  {
    question: "Buy the 56mm portrait lens or rent first?",
    options: ["buy", "rent for a weekend", "skip"],
    choice: "rent for a weekend",
    reasoning: "Two hundred dollar test beats a fourteen hundred dollar mistake.",
    expected: "Clear keep-or-skip signal after the rental",
    reviewInDays: 21,
    decidedDaysAgo: 10,
  },
  {
    question: "Adopt a cat from the shelter?",
    options: ["adopt now", "wait until after Tokyo trip", "no pet"],
    reasoning: "Travel schedule is the blocker; aquarium is lower maintenance.",
    reviewInDays: 60,
    decidedDaysAgo: 5,
  },
  {
    question: "Start the woodworking side business or keep it a hobby?",
    options: ["sell boards online", "keep as hobby"],
    choice: "keep as hobby",
    reasoning: "Monetizing hobbies has backfired before; see principle on hobby preservation.",
    expected: "Still enjoying woodworking in six months",
    reviewInDays: 180,
    decidedDaysAgo: 15,
  },
  {
    question: "Switch the home server from Debian to NixOS?",
    options: ["switch to NixOS", "stay on Debian"],
    choice: "stay on Debian",
    reasoning: "Boring beats clever for infrastructure I depend on daily.",
    expected: "Zero unplanned maintenance weekends",
    reviewInDays: 365,
    decidedDaysAgo: 30,
    outcome: "Server has needed nothing; right call.",
  },
];

const JOURNAL_TOPICS = [
  "Long run done before sunrise, legs heavy but the route along the river was worth it. Marathon plan on track.",
  "Hard day at work; the reconciliation diffs grew again. Wei Jie found the rounding culprit late evening.",
  "Coffee with Priya Sharma. She pushed me on saying the uncomfortable thing earlier. Writing it here so I do it.",
  "Climbing session: finally sent the V4 overhang project. Sam filmed it. Open-hand drills paying off.",
  "Quiet Sunday. Fed the sourdough starter, baked, read on the balcony. The good kind of boring.",
  "Anxious about the promotion case. Listed the evidence; it is stronger than the feeling says.",
  "Dinner at Mei's. Kai showed me his school robot. Ling drew the whole family as dinosaurs.",
  "Skipped meditation three days running. Phone back outside the bedroom tonight.",
  "Spanish exchange went well; held seven minutes on weekend plans before switching to English.",
  "Rain ruined the long run; treadmill instead. Mind numbing but the streak lives.",
  "Tokyo flights booked. Messaged Hana about the izakaya night. Already dreaming about the market breakfast.",
  "Reviewed the investing policy before the market dip news could tempt me. Did nothing, on purpose.",
  "On-call week: two pages, both false alarms from the new alert. Tuning thresholds tomorrow.",
  "Tired today, mood low for no clear reason. Early night, no screens.",
  "Built the walnut serving board glue-up. The clamps were the cheap part everyone said to not cheap out on. They were right.",
  "Lunch with Tom Becker who is visiting from San Francisco. Robotics sounds chaotic and fun. No envy, mostly.",
  "Aquarium rescape finished; the betta approves. Shrimp count somehow growing.",
  "Wrote the first weekly update email to the team. Felt like over-communicating; Jordan called it just right.",
  "Nadia's contractor friend quoted the kitchen. Within budget if we keep the existing layout.",
  "Slow morning, big breakfast, called Mei. Gratitude unprompted: health, work, people. Writing it down to remember.",
];

const INTERACTIONS: {
  person: string;
  kind: "meeting" | "call" | "message" | "email" | "note";
  summary: string;
  daysAgo: number;
}[] = [
  {
    person: "Jordan Lee",
    kind: "meeting",
    summary: "One-on-one: agreed reconciliation demo end of month; raised promotion timeline.",
    daysAgo: 3,
  },
  {
    person: "Priya Sharma",
    kind: "meeting",
    summary:
      "Monthly coffee: practice saying the uncomfortable thing earlier; book recommendation High Output Management.",
    daysAgo: 12,
  },
  {
    person: "Sam Chen",
    kind: "message",
    summary:
      "Sam loves espresso and bought a lever machine; invited me to test it Saturday after climbing.",
    daysAgo: 8,
  },
  {
    person: "Sam Chen",
    kind: "message",
    summary:
      "Sam says he hates espresso now after the third crash of the day; switching to tea, allegedly forever.",
    daysAgo: 2,
  },
  {
    person: "Mei Lin",
    kind: "call",
    summary:
      "Sunday call: kids school updates, Perth road trip dates maybe March, mum's birthday plan.",
    daysAgo: 7,
  },
  {
    person: "Hana Suzuki",
    kind: "email",
    summary:
      "Tokyo plans: she booked the izakaya for the second night, recommends Pit Inn jazz bar.",
    daysAgo: 14,
  },
  {
    person: "Wei Jie",
    kind: "meeting",
    summary: "Walked through the settlement rounding fix; ship behind a flag this sprint.",
    daysAgo: 4,
  },
  {
    person: "Rafael Ortiz",
    kind: "note",
    summary:
      "Rafael demonstrated open-hand grip drills; warns my crimping will cost a pulley if I keep it up.",
    daysAgo: 18,
  },
  {
    person: "Dr. Ng",
    kind: "meeting",
    summary: "Annual checkup booked; discussed resting heart rate trend, all normal ranges.",
    daysAgo: 30,
  },
  {
    person: "Tom Becker",
    kind: "meeting",
    summary:
      "Lunch while he visited from SF; his robotics startup is scaling; swap stories about on-call.",
    daysAgo: 9,
  },
  {
    person: "Nadia Rahman",
    kind: "message",
    summary:
      "Confirmed she can water plants during the Tokyo trip; gave her the contractor's invoice copy.",
    daysAgo: 6,
  },
  {
    person: "Jordan Lee",
    kind: "email",
    summary: "Sent first weekly progress update; he replied that the format is exactly right.",
    daysAgo: 5,
  },
  {
    person: "Mei Lin",
    kind: "message",
    summary:
      "Kai's birthday gift shortlist: microscope versus snap circuits. She votes microscope.",
    daysAgo: 1,
  },
  {
    person: "Sam Chen",
    kind: "meeting",
    summary: "Climbing session; sent the V4 overhang, he filmed it; celebrated with kaya toast.",
    daysAgo: 10,
  },
  {
    person: "Priya Sharma",
    kind: "email",
    summary:
      "Sent her my promotion case outline; she suggests leading with the reconciliation impact numbers.",
    daysAgo: 2,
  },
];

const MERCHANTS: [string, string, number, number][] = [
  // merchant, category, min cents, max cents (spend = negative)
  ["NTUC FairPrice", "groceries", 1500, 9500],
  ["Kopitiam", "food", 450, 1400],
  ["Grab", "transport", 800, 2600],
  ["Maxwell Hawker", "food", 400, 1200],
  ["Shopee", "shopping", 1200, 18000],
  ["Netflix", "subscriptions", 1790, 1790],
  ["Boulder Movement", "fitness", 3200, 3200],
  ["Guardian Pharmacy", "health", 600, 4500],
  ["SP Services", "utilities", 9000, 16000],
  ["Decathlon", "fitness", 1500, 12000],
  ["BookXcess", "books", 1200, 4800],
  ["Starbucks", "food", 650, 1250],
];

export async function seed(): Promise<Record<string, number>> {
  // refuse to double-seed (make seed on a live DB) unless forced
  if ((await listActivePages()).length > 0 && process.env.FORCE_SEED !== "1") {
    return { skipped: 1 };
  }
  const rand = mulberry32(20260610);
  const counts: Record<string, number> = {};

  // values, goals, principles
  const values = [
    "Health before output; the body keeps the score.",
    "Keep promises small and kept, not grand and broken.",
    "Boring infrastructure, interesting life.",
    "Spend on experiences with people, save on things.",
    "Write it down; memory is for thinking, not storage.",
  ];
  for (const v of values) await insertValueItem({ statement: v, source: "seed" });
  counts.values = values.length;

  const goals: ["life" | "year" | "quarter", string, string][] = [
    ["life", "Stay strong and mobile into old age", "Everything else depends on it"],
    ["year", "Reach senior engineer with a clean promotion case", "Compounding career capital"],
    ["year", "Run the Singapore marathon under 4:15", "A hard physical goal keeps training honest"],
    ["quarter", "Ship the payments reconciliation milestone two", "The promotion artifact"],
    ["quarter", "Hold a 15-minute Spanish conversation", "Visible progress sustains the habit"],
  ];
  for (const [horizon, statement, why] of goals)
    await insertGoal({ horizon, statement, why, source: "seed" });
  counts.goals = goals.length;

  const principles = [
    "Never monetize a hobby that restores you.",
    "Decide with a deadline; review with a calendar.",
    "When the market drops, re-read the policy before touching anything.",
    "Under-communication reads as no progress; send the weekly update.",
  ];
  for (const p of principles) await insertPrinciple({ rule: p, source: "seed" });
  counts.principles = principles.length;

  // people
  for (const p of PEOPLE) {
    const { id } = await ensurePerson(p.name, "human");
    if (p.alias) {
      const { addAlias } = await import("../src/db/repo");
      await addAlias(id, p.alias);
    }
    const { sql } = await import("../src/db/client");
    await sql`update people set relation = ${p.relation}, context = ${p.context}, source = 'seed' where id = ${id}`;
  }
  counts.people = PEOPLE.length;

  // pages: files are the archive (I4) — write the markdown into data/brain/ AND index rows,
  // so `minime sync` sees the same world the rows describe.
  const { mkdir } = await import("node:fs/promises");
  const { join, dirname } = await import("node:path");
  const { config } = await import("../src/util/config");
  for (const p of PAGES) {
    const file = join(config.dataDir, "brain", p.path);
    await mkdir(dirname(file), { recursive: true });
    const raw = `---\ntitle: ${p.title}\n---\n${p.body}`;
    await Bun.write(file, raw);
    // hash the raw file exactly as brain-sync does, so the first `minime sync` is a no-op
    const hash = new Bun.CryptoHasher("sha256").update(raw).digest("hex");
    const { id } = await upsertPage({
      path: p.path,
      title: p.title,
      bodyMd: p.body,
      contentHash: hash,
      source: "seed",
    });
    await indexParent("page", id, p.body, p.title, 1);
  }
  counts.pages = PAGES.length;

  // journal entries (tier 2)
  for (let i = 0; i < JOURNAL_TOPICS.length; i++) {
    const at = daysAgo(JOURNAL_TOPICS.length - i + Math.floor(rand() * 2));
    const mood = 2 + Math.floor(rand() * 4);
    const { id } = await insertJournal({
      entryMd: JOURNAL_TOPICS[i]!,
      mood,
      energy: Math.max(1, mood - 1 + Math.floor(rand() * 2)),
      at,
      source: "seed",
    });
    await indexParent("journal", id, JOURNAL_TOPICS[i]!, `Journal ${dateStr(at)}`, 2);
  }
  counts.journal = JOURNAL_TOPICS.length;

  // decisions
  for (const d of DECISIONS) {
    const decidedAt = d.decidedDaysAgo !== undefined && d.choice ? daysAgo(d.decidedDaysAgo) : null;
    const base = decidedAt ?? now();
    const reviewAt = dateStr(new Date(base.getTime() + d.reviewInDays * day));
    const { id } = await insertDecision({
      question: d.question,
      options: d.options,
      criteria: d.criteria,
      choice: d.choice ?? null,
      reasoning: d.reasoning ?? null,
      expectedOutcome: d.expected ?? null,
      decidedAt,
      reviewAt,
      source: "seed",
    });
    const md = `# Decision: ${d.question}\n\nOptions: ${d.options.join("; ")}\n\n${d.reasoning ?? ""}\n\n${d.outcome ? `Actual outcome: ${d.outcome}` : ""}`;
    if (d.outcome) {
      const { sql } = await import("../src/db/client");
      await sql`update decisions set actual_outcome = ${d.outcome}, reviewed_at = ${daysAgo(2)} where id = ${id}`;
    }
    await indexParent("decision", id, md, undefined, 1);
  }
  counts.decisions = DECISIONS.length;

  // tasks
  const tasks: [string, string, number | null][] = [
    ["Book Tokyo accommodation near Shinjuku", "active", 5],
    ["Renew passport before March", "active", 40],
    ["Send promotion case draft to Jordan", "active", 2],
    ["Buy Kai's birthday microscope", "inbox", 12],
    ["Rent the 56mm lens for the weekend", "active", 0],
    ["Fix the dripping kitchen tap", "waiting", -3],
    ["Schedule annual checkup with Dr. Ng", "done", -10],
    ["Order climbing chalk and finger tape", "inbox", null],
    ["Draft tech talk proposal", "inbox", 20],
    ["Water change for the aquarium", "active", 1],
  ];
  for (const [title, status, dueOffset] of tasks) {
    const { id } = await upsertTask({
      title,
      status,
      due: dueOffset === null ? null : dateStr(daysAhead(dueOffset)),
      source: "seed",
    });
    await indexParent("task", id, title, undefined, 1);
  }
  counts.tasks = tasks.length;

  // commitments
  const commitments: [string, string, number | null, string][] = [
    ["Review Wei Jie's settlement design doc", "Wei Jie", 2, "open"],
    ["Send Hana the Tokyo dates", "Hana Suzuki", -1, "kept"],
    ["Water plants info pack for Nadia", "Nadia Rahman", 10, "open"],
    ["Intro Priya to the new platform lead", "Priya Sharma", 7, "open"],
    ["Take Mei's kids to the Science Centre", "Mei Lin", 21, "open"],
  ];
  for (const [what, toWhom, dueOffset, status] of commitments) {
    await insertCommitment({
      what,
      toWhom,
      due: dueOffset === null ? null : dateStr(daysAhead(dueOffset)),
      status,
      source: "seed",
    });
  }
  counts.commitments = commitments.length;

  // interactions (tier 2)
  for (const i of INTERACTIONS) {
    const person = await ensurePerson(i.person, "human");
    const { id } = await insertInteraction({
      personId: person.id,
      kind: i.kind,
      summary: i.summary,
      occurredAt: daysAgo(i.daysAgo),
      source: "seed",
    });
    await indexParent("interaction", id, i.summary, undefined, 2);
  }
  counts.interactions = INTERACTIONS.length;

  // calendar: deep work blocks, meetings, future events for minime_state
  let cal = 0;
  for (let i = 0; i < 20; i++) {
    const start = daysAgo(20 - i);
    start.setHours(9, 0, 0, 0);
    const end = new Date(start.getTime() + 2 * 3600_000);
    await upsertCalendarEvent({
      uid: `seed-deepwork-${i}@minime`,
      startsAt: start,
      endsAt: end,
      title: "Deep work: reconciliation",
    });
    cal++;
  }
  const upcoming: [string, number, number, string, string | null][] = [
    ["Standup", 0, 10, "Team standup", null],
    ["1on1", 1, 14, "1:1 with Jordan Lee", "Lumenworks 12F"],
    ["Climb", 1, 19, "Climbing with Sam Chen", "Boulder Movement"],
    ["LongRun", 4, 6, "Marathon long run 28km", "East Coast Park"],
    ["Dinner", 2, 19, "Dinner at Mei's", "Punggol"],
  ];
  for (const [tag, dayOffset, hour, title, location] of upcoming) {
    const start = daysAhead(dayOffset);
    start.setHours(hour, 0, 0, 0);
    await upsertCalendarEvent({
      uid: `seed-${tag}@minime`,
      startsAt: start,
      endsAt: new Date(start.getTime() + 3600_000),
      title,
      location,
    });
    cal++;
  }
  counts.calendar = cal;

  // transactions (tier 0): ~200 over 90 days + salary credits. NEVER readable as content.
  let tx = 0;
  for (let i = 0; tx < 197; i++) {
    const merchant = MERCHANTS[Math.floor(rand() * MERCHANTS.length)]!;
    const cents = -Math.round(merchant[2] + rand() * (merchant[3] - merchant[2]));
    await insertTransaction({
      occurredAt: dateStr(daysAgo(Math.floor(rand() * 90))),
      amountCents: BigInt(cents),
      currency: "SGD",
      merchant: merchant[0],
      category: merchant[1],
      accountLabel: "dbs-main",
      externalRef: `seed-tx-${i}`,
    });
    tx++;
  }
  for (let m = 0; m < 3; m++) {
    await insertTransaction({
      occurredAt: dateStr(daysAgo(15 + m * 30)),
      amountCents: BigInt(6_200_00),
      currency: "SGD",
      merchant: "LUMENWORKS PTE LTD SALARY",
      category: "income",
      accountLabel: "dbs-main",
      externalRef: `seed-salary-${m}`,
    });
    tx++;
  }
  counts.transactions = tx;

  // health samples (tier 0): steps + sleep + resting hr daily for ~167 days ≈ 500 rows
  let hs = 0;
  for (let d = 0; d < 167; d++) {
    const at = daysAgo(d);
    at.setHours(6, 30, 0, 0);
    await insertHealthSample({
      kind: "steps",
      at,
      value: Math.round(4000 + rand() * 9000),
      unit: "steps",
      source: "seed-watch",
    });
    await insertHealthSample({
      kind: "sleep_minutes",
      at,
      value: Math.round(330 + rand() * 150),
      unit: "minutes",
      source: "seed-watch",
    });
    await insertHealthSample({
      kind: "hr_resting",
      at,
      value: Math.round(52 + rand() * 10),
      unit: "bpm",
      source: "seed-watch",
    });
    hs += 3;
  }
  counts.health_samples = hs;

  // link chunks to people so graph boost and the contradiction scan have edges
  await entityLinkPass(5000);
  await drainEmbedBacklog().catch(() => {});

  return counts;
}
