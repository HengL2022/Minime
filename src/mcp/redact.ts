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
  let out = s;

  // IBAN: 2 letters + 2 digits + 11-30 alphanumerics. Unconditional — no context word needed.
  out = out.replace(/\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/g, (m) => {
    if (isAllowlisted(m)) return m;
    count++;
    return "[REDACTED:iban]";
  });

  // card numbers: 13-19 digits, possibly separated by spaces/dashes, Luhn-valid. Unconditional.
  out = out.replace(/\b(?:\d[ -]?){13,19}\b/g, (m) => {
    const digits = m.replace(/[ -]/g, "");
    if (digits.length < 13 || digits.length > 19 || !luhnValid(digits)) return m;
    if (isAllowlisted(digits)) return m;
    count++;
    return "[REDACTED:card]";
  });

  // bare 9+ digit account-like numbers — context-gated (W4-10, ACCOUNT_CONTEXT_WORDS above).
  out = out.replace(/\b\d{9,}\b/g, (m: string, offset: number, full: string) => {
    if (isAllowlisted(m)) return m;
    const start = Math.max(0, offset - BARE_DIGIT_CONTEXT_RADIUS);
    const end = Math.min(full.length, offset + m.length + BARE_DIGIT_CONTEXT_RADIUS);
    if (!ACCOUNT_CONTEXT_WORDS.test(full.slice(start, end))) return m;
    count++;
    return "[REDACTED:account]";
  });

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
