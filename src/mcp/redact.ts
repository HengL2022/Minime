// Outbound redaction (spec §8): Luhn-valid card numbers, IBANs, and 9+ digit
// account-like numbers become [REDACTED:type] in every string leaving the server.

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

export function redactString(s: string): string {
  // split() with a capturing group interleaves the UUID matches at odd indices; redact only
  // the even-index gaps between them so ids pass through byte-identical.
  return s
    .split(UUID)
    .map((part, i) => (i % 2 === 1 ? part : redactSecrets(part)))
    .join("");
}

function redactSecrets(s: string): string {
  let out = s;

  // IBAN: 2 letters + 2 digits + 11-30 alphanumerics
  out = out.replace(/\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/g, "[REDACTED:iban]");

  // card numbers: 13-19 digits, possibly separated by spaces/dashes, Luhn-valid
  out = out.replace(/\b(?:\d[ -]?){13,19}\b/g, (m) => {
    const digits = m.replace(/[ -]/g, "");
    if (digits.length >= 13 && digits.length <= 19 && luhnValid(digits)) {
      return "[REDACTED:card]";
    }
    return m;
  });

  // bare 9+ digit account-like numbers
  out = out.replace(/\b\d{9,}\b/g, "[REDACTED:account]");

  return out;
}

// Walk any JSON-ish payload, redacting every string. Dates and numbers pass through.
export function redactDeep<T>(value: T): T {
  if (typeof value === "string") return redactString(value) as T;
  if (Array.isArray(value)) return value.map(redactDeep) as T;
  if (value instanceof Date) return value;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactDeep(v);
    return out as T;
  }
  return value;
}
