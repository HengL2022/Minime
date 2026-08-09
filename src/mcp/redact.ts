// Outbound redaction (spec §8): Luhn-valid card numbers, IBANs, and context-flagged 9+ digit
// account-like numbers become [REDACTED:type] in every string leaving the server. W4-10 added
// three refinements: (1) the bare-digit rule now fires only near an account/card-context word
// (IBAN and Luhn card stay unconditional); (2) REDACT_ALLOWLIST (env-only, util/config.ts)
// exempts owner-declared exact digit strings from every rule, including Luhn; (3) every
// redaction call also returns a count, so a caller can disclose that a returned number was
// altered instead of silently handing back a [REDACTED:*] placeholder.

import { config } from "../util/config";

function luhnValid(digits: string): boolean {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (alt) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    alt = !alt;
  }
  return sum % 10 === 0;
}

// Canonical UUIDs are server-generated identifiers, never secrets — but a v4 UUID's 12-hex
// node segment is all digits ~0.35% of the time, and digit runs spanning its dashes can be
// Luhn-valid, so the account/card rules below would mangle the occasional id into
// [REDACTED:*]. That corrupted decision_id/person_id and broke the one-door contract where
// agents re-pass returned ids (intermittent CI flake, 2026-06-15). Mask UUIDs out, redact
// the gaps, restore. No real card/IBAN/account number is UUID-shaped, so the guarantee holds.
const UUID = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi;

// W4-10: the bare 9+ digit rule only fires when one of these account/card-context words
// appears within BARE_DIGIT_CONTEXT_RADIUS chars of the match — an unqualified 9+ digit run
// (a phone number, a courier tracking number, a Unix epoch timestamp) used to be destroyed
// even though none of those are secrets. \b never matches around a CJK character (JS's \w is
// ASCII-only, so a Han character is never one side of a "word" boundary — confirmed:
// /\b账号\b/.test("账号 123456789") is false even though "账号" reads as a standalone word), so
// the CJK terms are matched bare while the ASCII terms keep \b to avoid firing inside an
// unrelated longer word (e.g. "accountant").
const ACCOUNT_CONTEXT_WORDS =
  /\b(?:account|acct|a\/c|iban|routing|swift|acct\.?\s*no|account\s*number)\b|账号|账户|卡号/i;
const BARE_DIGIT_CONTEXT_RADIUS = 40;

// W4-10: owner-declared exact digit strings (their own phone/reference numbers) exempt from
// every rule below, including Luhn. REDACT_ALLOWLIST is env-sourced only (see
// parseRedactAllowlist in util/config.ts) — no MCP tool schema exposes a parameter that reaches
// this, so no agent request can add to, see, or otherwise influence it. Read from `config` on
// every call (never cached here) so it always reflects the current owner setting.
function isAllowlisted(digits: string): boolean {
  return config.redactAllowlist.has(digits);
}

interface Counted<T> {
  value: T;
  count: number;
}

export function redactString(s: string): string {
  return redactStringCounted(s).value;
}

// split() with a capturing group interleaves the UUID matches at odd indices; redact only
// the even-index gaps between them so ids pass through byte-identical.
export function redactStringCounted(s: string): Counted<string> {
  let count = 0;
  const value = s
    .split(UUID)
    .map((part, i) => {
      if (i % 2 === 1) return part;
      const redacted = redactSecretsCounted(part);
      count += redacted.count;
      return redacted.value;
    })
    .join("");
  return { value, count };
}

function redactSecretsCounted(s: string): Counted<string> {
  let count = 0;
  const original = s;

  // A same-length working copy of `original`. Every span an earlier pass redacts gets
  // overwritten in place with '#' filler (never a digit or letter), so a later pass can neither
  // re-match its digits nor be gated by trigger words leaking in from placeholder text (the
  // literal "[REDACTED:iban]" contains "iban" — see the "unrelated bare digit run near a
  // redacted IBAN survives" test below). Because the filler is exactly as long as what it
  // replaces, `masked` and `original` share the same coordinates at every step: a match's
  // `.index` against `masked` IS its offset in `original`, nothing to derive.
  //
  // An earlier version of this function let each pass shrink a working string with the real
  // "[REDACTED:*]" text instead, then recovered the bare-digit pass's true offset afterwards via
  // `original.indexOf(match, cursor)`. That silently finds the WRONG occurrence whenever the
  // matched digit *value* recurs — once inside an already-redacted IBAN/card span and once
  // standalone (e.g. a message that states an IBAN and later separately quotes that IBAN's own
  // account-number digits) — so it could evaluate ACCOUNT_CONTEXT_WORDS against a completely
  // unrelated window, both missing a genuinely context-flagged number and wrongly flagging an
  // unrelated one. Tracking every span by position, never by re-deriving it from value, removes
  // that whole class of bug.
  let masked = original;
  const edits: { start: number; end: number; text: string }[] = [];
  const consume = (start: number, end: number, text: string) => {
    edits.push({ start, end, text });
    masked = masked.slice(0, start) + "#".repeat(end - start) + masked.slice(end);
  };

  // IBAN: 2 letters + 2 digits + 11-30 alphanumerics. Unconditional — no context word needed.
  for (const m of masked.matchAll(/\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/g)) {
    const text = m[0]!;
    if (isAllowlisted(text)) continue;
    count++;
    consume(m.index!, m.index! + text.length, "[REDACTED:iban]");
  }

  // card numbers: 13-19 digits, possibly separated by spaces/dashes, Luhn-valid. Unconditional.
  for (const m of masked.matchAll(/\b(?:\d[ -]?){13,19}\b/g)) {
    const text = m[0]!;
    const digits = text.replace(/[ -]/g, "");
    if (digits.length < 13 || digits.length > 19 || !luhnValid(digits)) continue;
    if (isAllowlisted(digits)) continue;
    count++;
    consume(m.index!, m.index! + text.length, "[REDACTED:card]");
  }

  // bare 9+ digit account-like numbers — context-gated (W4-10, ACCOUNT_CONTEXT_WORDS above).
  // The window is read from `original`, not `masked`: `masked` exists only to keep offsets
  // aligned across passes, and the real question is whether genuine surrounding text mentions
  // an account.
  for (const m of masked.matchAll(/\b\d{9,}\b/g)) {
    const text = m[0]!;
    if (isAllowlisted(text)) continue;
    const start = Math.max(0, m.index! - BARE_DIGIT_CONTEXT_RADIUS);
    const end = Math.min(original.length, m.index! + text.length + BARE_DIGIT_CONTEXT_RADIUS);
    if (!ACCOUNT_CONTEXT_WORDS.test(original.slice(start, end))) continue;
    count++;
    consume(m.index!, m.index! + text.length, "[REDACTED:account]");
  }

  // Materialize the real placeholder text over `original`, right to left (descending start) so
  // applying one edit never shifts the recorded offset of an edit still waiting to be applied.
  // `edits` isn't naturally in that order — IBAN, card, and bare-digit run as three separate
  // left-to-right passes, not one merged scan.
  edits.sort((a, b) => b.start - a.start);
  let out = original;
  for (const e of edits) out = out.slice(0, e.start) + e.text + out.slice(e.end);

  return { value: out, count };
}

// Walk any JSON-ish payload, redacting every string. Dates and numbers pass through.
export function redactDeep<T>(value: T): T {
  return redactDeepCounted(value).value;
}

// Counting sibling of redactDeep (W4-10), used by registry.ts to disclose in an envelope's
// `gaps` how many number-like strings got redacted, instead of silently handing back
// [REDACTED:*] placeholders with no indication anything changed.
export function redactDeepCounted<T>(value: T): Counted<T> {
  if (typeof value === "string") {
    const redacted = redactStringCounted(value);
    return { value: redacted.value as T, count: redacted.count };
  }
  if (Array.isArray(value)) {
    let count = 0;
    const out = value.map((item) => {
      const redacted = redactDeepCounted(item);
      count += redacted.count;
      return redacted.value;
    });
    return { value: out as T, count };
  }
  if (value instanceof Date) return { value, count: 0 };
  if (value && typeof value === "object") {
    let count = 0;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const redacted = redactDeepCounted(v);
      out[k] = redacted.value;
      count += redacted.count;
    }
    return { value: out as T, count };
  }
  return { value, count: 0 };
}
