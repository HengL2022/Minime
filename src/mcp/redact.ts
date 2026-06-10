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

export function redactString(s: string): string {
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
