// ICS importer: upserts calendar_events by UID. Idempotent — re-running an export is a no-op.
// Minimal RFC 5545 parsing: VEVENT blocks, folded lines, common DTSTART/DTEND shapes.

import { logEvent, upsertCalendarEvent } from "../db/repo";

export interface ImportStats {
  total: number;
  inserted: number;
  updated: number;
  skipped: number; // malformed rows: logged, never fatal (M4 AC)
}

function unfold(ics: string): string[] {
  const lines = ics.split(/\r?\n/);
  const out: string[] = [];
  for (const line of lines) {
    if ((line.startsWith(" ") || line.startsWith("\t")) && out.length > 0) {
      out[out.length - 1] += line.slice(1);
    } else {
      out.push(line);
    }
  }
  return out;
}

// DTSTART variants: 20260115T090000Z | 20260115T090000 (floating: treat as local) | 20260115 (all-day)
export function parseIcsDate(value: string): Date | null {
  let m = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/);
  if (m) {
    const [, y, mo, d, h, mi, s, z] = m;
    return z === "Z"
      ? new Date(Date.UTC(+y!, +mo! - 1, +d!, +h!, +mi!, +s!))
      : new Date(+y!, +mo! - 1, +d!, +h!, +mi!, +s!);
  }
  m = value.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m) return new Date(+m[1]!, +m[2]! - 1, +m[3]!);
  return null;
}

interface VEvent {
  uid?: string;
  dtstart?: string;
  dtend?: string;
  summary?: string;
  location?: string;
  attendees: string[];
}

export function parseIcs(ics: string): VEvent[] {
  const events: VEvent[] = [];
  let cur: VEvent | null = null;
  for (const line of unfold(ics)) {
    if (line === "BEGIN:VEVENT") {
      cur = { attendees: [] };
      continue;
    }
    if (line === "END:VEVENT") {
      if (cur) events.push(cur);
      cur = null;
      continue;
    }
    if (!cur) continue;
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const [keyPart, value] = [line.slice(0, idx), line.slice(idx + 1)];
    const key = keyPart!.split(";")[0]!.toUpperCase();
    switch (key) {
      case "UID":
        cur.uid = value;
        break;
      case "DTSTART":
        cur.dtstart = value;
        break;
      case "DTEND":
        cur.dtend = value;
        break;
      case "SUMMARY":
        cur.summary = value!.replace(/\\,/g, ",").replace(/\\n/g, "\n");
        break;
      case "LOCATION":
        cur.location = value!.replace(/\\,/g, ",");
        break;
      case "ATTENDEE":
        cur.attendees.push(value!.replace(/^mailto:/i, ""));
        break;
    }
  }
  return events;
}

export async function importCalendar(icsText: string): Promise<ImportStats> {
  const stats: ImportStats = { total: 0, inserted: 0, updated: 0, skipped: 0 };
  for (const ev of parseIcs(icsText)) {
    stats.total++;
    const starts = ev.dtstart ? parseIcsDate(ev.dtstart) : null;
    if (!ev.uid || !starts || !ev.summary) {
      stats.skipped++;
      await logEvent({
        actor: "importer:calendar",
        verb: "import:malformed",
        payload: { reason: "missing uid/dtstart/summary" },
      });
      continue;
    }
    const inserted = await upsertCalendarEvent({
      uid: ev.uid,
      startsAt: starts,
      endsAt: ev.dtend ? parseIcsDate(ev.dtend) : null,
      title: ev.summary,
      location: ev.location ?? null,
      attendees: ev.attendees.length ? ev.attendees : null,
    });
    if (inserted) stats.inserted++;
    else stats.updated++;
  }
  await logEvent({ actor: "importer:calendar", verb: "import:calendar", payload: stats as any });
  return stats;
}
