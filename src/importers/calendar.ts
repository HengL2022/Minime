// ICS importer: upserts calendar_events by UID. Idempotent — re-running an export is a no-op.
// Supports the RFC 5545 date forms Minime stores: UTC, TZID, floating, and all-day DATE.

import { logEvent, upsertCalendarEvent } from "../db/repo";
import { auditPayload } from "../util/audit-payload";
import { localDateTimeToUtc, nextLocalMidnight } from "../util/clock";
import { config } from "../util/config";

export interface ImportStats {
  total: number;
  inserted: number;
  updated: number;
  skipped: number;
}

export interface IcsDateProperty {
  value: string;
  params: Readonly<Record<string, string>>;
}

export interface VEvent {
  uid?: string;
  dtstart?: IcsDateProperty;
  dtend?: IcsDateProperty;
  summary?: string;
  location?: string;
  attendees: string[];
  malformedDateProperty?: boolean;
}

interface ContentLine {
  name: string;
  value: string;
  params: Record<string, string>;
  valid: boolean;
}

interface ParsedIcsDate {
  instant: Date;
  valueType: "DATE" | "DATE-TIME";
  year: number;
  month: number;
  day: number;
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

function splitOutsideQuotes(value: string, separator: string): string[] | null {
  const parts: string[] = [];
  let quoted = false;
  let start = 0;
  for (let index = 0; index < value.length; index++) {
    if (value[index] === '"') quoted = !quoted;
    if (value[index] === separator && !quoted) {
      parts.push(value.slice(start, index));
      start = index + 1;
    }
  }
  if (quoted) return null;
  parts.push(value.slice(start));
  return parts;
}

function indexOutsideQuotes(value: string, separator: string): number {
  let quoted = false;
  for (let index = 0; index < value.length; index++) {
    if (value[index] === '"') quoted = !quoted;
    else if (value[index] === separator && !quoted) return index;
  }
  return -1;
}

function parseContentLine(line: string): ContentLine | null {
  const separator = indexOutsideQuotes(line, ":");
  if (separator <= 0) return null;
  const header = line.slice(0, separator);
  const fields = splitOutsideQuotes(header, ";");
  if (!fields?.length) return null;
  const name = fields.shift()!.toUpperCase();
  const params: Record<string, string> = {};
  let valid = /^[A-Z0-9-]+$/.test(name);

  for (const field of fields) {
    const equals = field.indexOf("=");
    const key = field.slice(0, equals).toUpperCase();
    let parameterValue = field.slice(equals + 1);
    if (equals <= 0 || !/^[A-Z0-9-]+$/.test(key) || key in params) {
      valid = false;
      continue;
    }
    if (parameterValue.startsWith('"') || parameterValue.endsWith('"')) {
      if (!(parameterValue.startsWith('"') && parameterValue.endsWith('"'))) valid = false;
      else parameterValue = parameterValue.slice(1, -1);
    }
    if (!parameterValue) valid = false;
    params[key] = key === "VALUE" ? parameterValue.toUpperCase() : parameterValue;
  }
  return { name, value: line.slice(separator + 1), params, valid };
}

function rawPropertyName(line: string): string {
  const separator = line.search(/[;:]/);
  return line.slice(0, separator < 0 ? line.length : separator).toUpperCase();
}

function assignDateProperty(event: VEvent, line: ContentLine): void {
  const key = line.name === "DTSTART" ? "dtstart" : "dtend";
  if (event[key]) event.malformedDateProperty = true;
  event[key] = { value: line.value, params: line.params };
  if (!line.valid) event.malformedDateProperty = true;
}

export function parseIcs(ics: string): VEvent[] {
  const events: VEvent[] = [];
  let current: VEvent | null = null;
  for (const rawLine of unfold(ics)) {
    if (rawLine === "BEGIN:VEVENT") {
      current = { attendees: [] };
      continue;
    }
    if (rawLine === "END:VEVENT") {
      if (current) events.push(current);
      current = null;
      continue;
    }
    if (!current) continue;
    const line = parseContentLine(rawLine);
    if (!line) {
      if (["DTSTART", "DTEND"].includes(rawPropertyName(rawLine))) {
        current.malformedDateProperty = true;
      }
      continue;
    }
    if (line.name === "DTSTART" || line.name === "DTEND") {
      assignDateProperty(current, line);
      continue;
    }
    switch (line.name) {
      case "UID":
        current.uid = line.value;
        break;
      case "SUMMARY":
        current.summary = line.value.replace(/\\,/g, ",").replace(/\\n/gi, "\n");
        break;
      case "LOCATION":
        current.location = line.value.replace(/\\,/g, ",");
        break;
      case "ATTENDEE":
        current.attendees.push(line.value.replace(/^mailto:/i, ""));
        break;
    }
  }
  return events;
}

function normalizeDateProperty(value: string | IcsDateProperty): IcsDateProperty | null {
  if (typeof value === "string") return { value, params: {} };
  const params: Record<string, string> = {};
  for (const [rawKey, rawValue] of Object.entries(value.params)) {
    const key = rawKey.toUpperCase();
    if (key in params || typeof rawValue !== "string" || !rawValue) return null;
    params[key] = key === "VALUE" ? rawValue.toUpperCase() : rawValue;
  }
  return { value: value.value, params };
}

function parseIcsDateValue(
  input: string | IcsDateProperty,
  defaultTimeZone: string,
): ParsedIcsDate | null {
  const property = normalizeDateProperty(input);
  if (!property) return null;
  const dateMatch = property.value.match(/^(\d{4})(\d{2})(\d{2})$/);
  const dateTimeMatch = property.value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/);
  const valueType = property.params.VALUE;
  if (valueType && valueType !== "DATE" && valueType !== "DATE-TIME") return null;
  if ((valueType === "DATE" && !dateMatch) || (valueType === "DATE-TIME" && !dateTimeMatch)) {
    return null;
  }
  if (!dateMatch && !dateTimeMatch) return null;

  const match = dateMatch ?? dateTimeMatch!;
  const [, year, month, day, hour = "0", minute = "0", second = "0", utc = ""] = match;
  const tzid = property.params.TZID;
  if ((dateMatch && tzid) || (utc === "Z" && tzid) || tzid === "") return null;
  try {
    return {
      instant: localDateTimeToUtc(
        +year!,
        +month!,
        +day!,
        +hour,
        +minute,
        +second,
        0,
        utc === "Z" ? "UTC" : (tzid ?? defaultTimeZone),
      ),
      valueType: dateMatch ? "DATE" : "DATE-TIME",
      year: +year!,
      month: +month!,
      day: +day!,
    };
  } catch {
    return null;
  }
}

// Compatibility: callers may still pass the old raw string. Floating values now use the
// configured owner timezone rather than the JavaScript process timezone.
export function parseIcsDate(
  value: string | IcsDateProperty,
  defaultTimeZone = config.tz,
): Date | null {
  return parseIcsDateValue(value, defaultTimeZone)?.instant ?? null;
}

function resolveEventTimes(event: VEvent): { startsAt: Date; endsAt: Date | null } | null {
  if (event.malformedDateProperty || !event.dtstart) return null;
  const start = parseIcsDateValue(event.dtstart, config.tz);
  if (!start) return null;
  const explicitEnd = event.dtend ? parseIcsDateValue(event.dtend, config.tz) : null;
  if (event.dtend && (!explicitEnd || explicitEnd.valueType !== start.valueType)) return null;

  let endsAt = explicitEnd?.instant ?? null;
  if (!event.dtend && start.valueType === "DATE") {
    try {
      endsAt = nextLocalMidnight(start.year, start.month, start.day, config.tz);
    } catch {
      return null;
    }
  }
  if (endsAt && endsAt.getTime() <= start.instant.getTime()) return null;
  return { startsAt: start.instant, endsAt };
}

async function logMalformed(recordNumber: number): Promise<void> {
  await logEvent({
    actor: "importer:calendar",
    verb: "import:malformed",
    payload: auditPayload.importMalformed({
      importer: "calendar",
      reason: "missing_required_fields",
      recordNumber,
    }),
  });
}

export async function importCalendar(icsText: string): Promise<ImportStats> {
  const stats: ImportStats = { total: 0, inserted: 0, updated: 0, skipped: 0 };
  for (const event of parseIcs(icsText)) {
    stats.total++;
    const times = resolveEventTimes(event);
    if (!event.uid || !event.summary || !times) {
      stats.skipped++;
      await logMalformed(stats.total);
      continue;
    }
    const inserted = await upsertCalendarEvent({
      uid: event.uid,
      startsAt: times.startsAt,
      endsAt: times.endsAt,
      title: event.summary,
      location: event.location ?? null,
      attendees: event.attendees.length ? event.attendees : null,
    });
    if (inserted) stats.inserted++;
    else stats.updated++;
  }
  await logEvent({
    actor: "importer:calendar",
    verb: "import:calendar",
    payload: auditPayload.importSummary({ importer: "calendar", ...stats }),
  });
  return stats;
}
