// Apple Health export importer: stream-parses export.xml (those files reach gigabytes,
// never load whole). Whitelisted kinds only; dedupe on (kind, at, source).

import { insertHealthSample, logEvent } from "../db/repo";
import type { ImportStats } from "./calendar";

// HK identifier -> our kind + how to interpret the record
const KIND_WHITELIST: Record<
  string,
  { kind: string; unit: string; mode: "value" | "duration_minutes" }
> = {
  HKQuantityTypeIdentifierStepCount: { kind: "steps", unit: "steps", mode: "value" },
  HKQuantityTypeIdentifierRestingHeartRate: { kind: "hr_resting", unit: "bpm", mode: "value" },
  HKQuantityTypeIdentifierHeartRate: { kind: "hr", unit: "bpm", mode: "value" },
  HKQuantityTypeIdentifierBodyMass: { kind: "body_mass", unit: "kg", mode: "value" },
  HKCategoryTypeIdentifierSleepAnalysis: {
    kind: "sleep_minutes",
    unit: "minutes",
    mode: "duration_minutes",
  },
};

function attr(tag: string, name: string): string | null {
  const m = tag.match(new RegExp(`${name}="([^"]*)"`));
  return m ? m[1]! : null;
}

// Apple Health dates: "2026-01-15 07:30:00 +0800"
export function parseHealthDate(s: string): Date | null {
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2}) ([+-]\d{4})$/);
  if (!m) return null;
  const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${m[7]!.slice(0, 3)}:${m[7]!.slice(3)}`;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

export async function importHealthRecord(tag: string, stats: ImportStats): Promise<void> {
  const type = attr(tag, "type");
  if (!type) return;
  const spec = KIND_WHITELIST[type];
  stats.total++;
  if (!spec) {
    stats.skipped++;
    return; // not whitelisted: silently skipped, by design
  }
  const startRaw = attr(tag, "startDate");
  const start = startRaw ? parseHealthDate(startRaw) : null;
  if (!start) {
    stats.skipped++;
    await logEvent({
      actor: "importer:health",
      verb: "import:malformed",
      payload: { reason: "bad startDate", type },
    });
    return;
  }
  let value: number;
  if (spec.mode === "duration_minutes") {
    const endRaw = attr(tag, "endDate");
    const end = endRaw ? parseHealthDate(endRaw) : null;
    // only count actual sleep stages, not in-bed
    const v = attr(tag, "value") ?? "";
    if (!end || !/Asleep/i.test(v)) {
      stats.skipped++;
      return;
    }
    value = (end.getTime() - start.getTime()) / 60_000;
  } else {
    const raw = attr(tag, "value");
    value = Number(raw);
    if (raw === null || Number.isNaN(value)) {
      stats.skipped++;
      await logEvent({
        actor: "importer:health",
        verb: "import:malformed",
        payload: { reason: "bad value", type },
      });
      return;
    }
  }
  const source = attr(tag, "sourceName") ?? "apple-health";
  const inserted = await insertHealthSample({
    kind: spec.kind,
    at: start,
    value,
    unit: spec.unit,
    source,
  });
  if (inserted) stats.inserted++;
  else stats.updated++;
}

export async function importHealth(filePath: string): Promise<ImportStats> {
  const stats: ImportStats = { total: 0, inserted: 0, updated: 0, skipped: 0 };
  const stream = Bun.file(filePath).stream();
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of stream) {
    buf += decoder.decode(chunk, { stream: true });
    // pull out complete <Record .../> tags; keep the remainder buffered
    let m: RegExpMatchArray | null;
    // biome-ignore lint/suspicious/noAssignInExpressions: streaming scanner
    while ((m = buf.match(/<Record\b[^>]*\/>/)) !== null) {
      await importHealthRecord(m[0], stats);
      buf = buf.slice(m.index! + m[0].length);
    }
    // avoid unbounded growth if the file has no Record tags in this stretch
    if (buf.length > 1_000_000) buf = buf.slice(-100_000);
  }
  await logEvent({ actor: "importer:health", verb: "import:health", payload: stats as any });
  return stats;
}
