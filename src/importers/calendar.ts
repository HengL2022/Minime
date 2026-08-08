// ICS importer: upserts calendar_events keyed on (uid, occurrence_start). Idempotent —
// re-running an identical export is a no-op. Supports the RFC 5545 date forms Minime stores:
// UTC, TZID, floating, and all-day DATE — and expands RRULE/RDATE/EXDATE into one row per
// occurrence via the pure src/importers/rrule.ts module (migration 031).

import { deleteCalendarOccurrencesNotIn, logEvent, upsertCalendarEvent } from "../db/repo";
import { auditPayload } from "../util/audit-payload";
import { localDateTimeToUtc, nextLocalMidnight, now } from "../util/clock";
import { config } from "../util/config";
import {
  type RecurrenceDate,
  addCalendarDays,
  calendarDaysBetween,
  expandOccurrences,
} from "./rrule";

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
  // Raw RRULE value (undefined = property absent; "" = present but empty/malformed content
  // line, which expandOccurrences also treats as unsupported rather than silently ignoring).
  rrule?: string;
  rdate: IcsDateProperty[];
  exdate: IcsDateProperty[];
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
  hour: number;
  minute: number;
  second: number;
  // Resolved zone this instant was computed in: "UTC" for a Z-suffixed value, the TZID param
  // when present, else the caller's default (config.tz for a floating DTSTART/DTEND, also
  // config.tz for RDATE/EXDATE — see toRecurrenceDates). Needed by expandOccurrences to keep
  // generated occurrences in the same zone as DTSTART.
  zone: string;
}

interface TimeOfDay {
  hour: number;
  minute: number;
  second: number;
}

interface ResolvedEventTimes {
  startsAt: Date;
  endsAt: Date | null;
  start: ParsedIcsDate;
  // Calendar-day offset from DTSTART's date to DTEND's date (0 for a same-day timed event, 1
  // for a plain all-day event with no explicit DTEND, etc.) plus the end's own wall-clock
  // time-of-day — together these let a recurring occurrence recompute its own end by shifting
  // DTSTART's end relationship onto its own date, instead of reusing a fixed millisecond
  // duration (which would drift by an hour across a DST transition). endTimeOfDay is null
  // exactly when endsAt is null (a timed event with no DTEND has no computed end at all).
  endDayOffset: number;
  endTimeOfDay: TimeOfDay | null;
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
      current = { attendees: [], rdate: [], exdate: [] };
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
      case "RRULE":
        // A malformed content line (bad parameter shape) sets rrule to "" rather than the raw
        // text — expandOccurrences treats an empty value as an unsupported rule (no FREQ), the
        // same safe-degrade path as any other unparseable RRULE, rather than trusting a value
        // whose own syntax already failed to parse.
        current.rrule = line.valid ? line.value : "";
        break;
      case "RDATE":
        if (line.valid) {
          for (const value of line.value.split(",")) {
            current.rdate.push({ value, params: line.params });
          }
        }
        break;
      case "EXDATE":
        if (line.valid) {
          for (const value of line.value.split(",")) {
            current.exdate.push({ value, params: line.params });
          }
        }
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
  const zone = utc === "Z" ? "UTC" : (tzid ?? defaultTimeZone);
  try {
    return {
      instant: localDateTimeToUtc(+year!, +month!, +day!, +hour, +minute, +second, 0, zone),
      valueType: dateMatch ? "DATE" : "DATE-TIME",
      year: +year!,
      month: +month!,
      day: +day!,
      hour: +hour,
      minute: +minute,
      second: +second,
      zone,
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

// Unchanged from the pre-recurrence importer for startsAt/endsAt: same conditions, same
// values. Only the extra endDayOffset/endTimeOfDay/start fields are new, computed alongside
// without altering any existing branch — recurring occurrences need them, but a non-recurring
// or RRULE-unsupported event never consults them (it reuses endsAt directly; see
// buildOccurrences), so this function's observable behavior for every pre-existing test is
// byte-for-byte identical to before.
function resolveEventTimes(event: VEvent): ResolvedEventTimes | null {
  if (event.malformedDateProperty || !event.dtstart) return null;
  const start = parseIcsDateValue(event.dtstart, config.tz);
  if (!start) return null;
  const explicitEnd = event.dtend ? parseIcsDateValue(event.dtend, config.tz) : null;
  if (event.dtend && (!explicitEnd || explicitEnd.valueType !== start.valueType)) return null;

  let endsAt = explicitEnd?.instant ?? null;
  let endDayOffset = 0;
  let endTimeOfDay: TimeOfDay | null = explicitEnd
    ? { hour: explicitEnd.hour, minute: explicitEnd.minute, second: explicitEnd.second }
    : null;
  if (explicitEnd) {
    endDayOffset = calendarDaysBetween(start, explicitEnd);
  } else if (start.valueType === "DATE") {
    try {
      endsAt = nextLocalMidnight(start.year, start.month, start.day, config.tz);
      endDayOffset = 1;
      endTimeOfDay = { hour: 0, minute: 0, second: 0 };
    } catch {
      return null;
    }
  }
  if (endsAt && endsAt.getTime() <= start.instant.getTime()) return null;
  return { startsAt: start.instant, endsAt, start, endDayOffset, endTimeOfDay };
}

// Recompute one occurrence's end by applying the ORIGINAL event's day-offset + time-of-day
// (see ResolvedEventTimes) to that occurrence's own date, in DTSTART's own zone — never a fixed
// millisecond duration, which would silently shift wall-clock time across a DST transition.
function occurrenceEnd(occ: RecurrenceDate, times: ResolvedEventTimes): Date | null {
  if (!times.endTimeOfDay) return null;
  const end = addCalendarDays(occ.year, occ.month, occ.day, times.endDayOffset);
  return localDateTimeToUtc(
    end.year,
    end.month,
    end.day,
    times.endTimeOfDay.hour,
    times.endTimeOfDay.minute,
    times.endTimeOfDay.second,
    0,
    times.start.zone,
  );
}

// RDATE/EXDATE values, parsed through the same parseIcsDateValue used for DTSTART/DTEND —
// same TZID/floating/UTC handling, same VALUE=DATE support. An individual entry that fails to
// parse is dropped rather than failing the whole event: a single bad exception/addition date is
// a minor degrade, not the "we don't understand this recurrence" case RRULE-unsupported exists
// for, so it gets no audit event of its own.
function toRecurrenceDates(props: IcsDateProperty[]): RecurrenceDate[] {
  const out: RecurrenceDate[] = [];
  for (const prop of props) {
    const parsed = parseIcsDateValue(prop, config.tz);
    if (parsed)
      out.push({
        instant: parsed.instant,
        year: parsed.year,
        month: parsed.month,
        day: parsed.day,
      });
  }
  return out;
}

const RECURRENCE_WINDOW_MONTHS = 12;
const RECURRENCE_CAP = 500;

// Rolling window: every import expands from "now" through 12 months out, so a re-import months
// later naturally picks up the next slice of the future without needing to re-walk history.
function recurrenceWindowEnd(importTime: Date): Date {
  const end = new Date(importTime.getTime());
  end.setUTCMonth(end.getUTCMonth() + RECURRENCE_WINDOW_MONTHS);
  return end;
}

interface Occurrence {
  startsAt: Date;
  endsAt: Date | null;
}

interface BuiltOccurrences {
  occurrences: Occurrence[];
  unsupported: boolean;
}

// Non-recurring events, and RRULE-unsupported fallbacks, both resolve to exactly one occurrence
// that reuses `times.endsAt` verbatim (DTEND's own zone) rather than the recomputed
// occurrenceEnd — preserving the pre-recurrence importer's exact TZ semantics for every event
// that isn't genuinely expanding into more than one row.
function buildOccurrences(
  event: VEvent,
  times: ResolvedEventTimes,
  windowStart: Date,
  windowEnd: Date,
): BuiltOccurrences {
  const isRecurring =
    event.rrule !== undefined || event.rdate.length > 0 || event.exdate.length > 0;
  if (!isRecurring) {
    return {
      occurrences: [{ startsAt: times.startsAt, endsAt: times.endsAt }],
      unsupported: false,
    };
  }
  const expansion = expandOccurrences(
    times.start,
    event.rrule,
    toRecurrenceDates(event.rdate),
    toRecurrenceDates(event.exdate),
    windowStart,
    windowEnd,
    RECURRENCE_CAP,
  );
  if (expansion.unsupported) {
    return { occurrences: [{ startsAt: times.startsAt, endsAt: times.endsAt }], unsupported: true };
  }
  return {
    occurrences: expansion.occurrences.map((occ) => ({
      startsAt: occ.instant,
      endsAt: occurrenceEnd(occ, times),
    })),
    unsupported: false,
  };
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

// Mirrors logMalformed: content-free (no RRULE text, no title) audit row flagging that this
// event's RRULE had an unsupported part (see src/importers/rrule.ts's module comment for the
// exact allow-list) and was degraded to importing DTSTART alone.
async function logRruleUnsupported(recordNumber: number): Promise<void> {
  await logEvent({
    actor: "importer:calendar",
    verb: "import:rrule-unsupported",
    payload: auditPayload.importMalformed({
      importer: "calendar",
      reason: "unsupported_rrule",
      recordNumber,
    }),
  });
}

export async function importCalendar(icsText: string): Promise<ImportStats> {
  const stats: ImportStats = { total: 0, inserted: 0, updated: 0, skipped: 0 };
  const importTime = now();
  const windowEnd = recurrenceWindowEnd(importTime);
  for (const event of parseIcs(icsText)) {
    stats.total++;
    const times = resolveEventTimes(event);
    if (!event.uid || !event.summary || !times) {
      stats.skipped++;
      await logMalformed(stats.total);
      continue;
    }

    const { occurrences, unsupported } = buildOccurrences(event, times, importTime, windowEnd);
    if (unsupported) await logRruleUnsupported(stats.total);

    const keepInstants: Date[] = [];
    for (const occ of occurrences) {
      const inserted = await upsertCalendarEvent({
        uid: event.uid,
        occurrenceStart: occ.startsAt,
        startsAt: occ.startsAt,
        endsAt: occ.endsAt,
        title: event.summary,
        location: event.location ?? null,
        attendees: event.attendees.length ? event.attendees : null,
      });
      if (inserted) stats.inserted++;
      else stats.updated++;
      keepInstants.push(occ.startsAt);
    }
    // Prune every uid seen in this file, not only ones with an RRULE this time around: a
    // previously-recurring event whose export dropped the RRULE (converted to a one-off, same
    // UID) must also lose its now-stale future occurrences. Always scoped to occurrence_start >=
    // importTime, so past occurrences are never touched and the whole operation is re-creatable
    // from any export (see DECISIONS.md).
    await deleteCalendarOccurrencesNotIn(event.uid, importTime, keepInstants);
  }
  await logEvent({
    actor: "importer:calendar",
    verb: "import:calendar",
    payload: auditPayload.importSummary({ importer: "calendar", ...stats }),
  });
  return stats;
}
