// Outbound redaction (spec §8) must scrub cards/IBANs/account numbers from every string
// leaving the server WITHOUT mangling server-generated UUIDs. A v4 UUID's all-digit node
// segment (~0.35% of ids) and Luhn-valid digit runs spanning its dashes used to be eaten by
// the account/card rules, corrupting returned ids and breaking the one-door contract where
// agents re-pass them (intermittent CI flake, 2026-06-15). Fully offline; fixtures fictional.

import { describe, expect, test } from "bun:test";
import { redactDeep, redactString } from "../src/mcp/redact";

describe("redaction still scrubs real secrets", () => {
  test("Luhn-valid card, IBAN, and 9+ digit account numbers go away", () => {
    expect(redactString("card 4111 1111 1111 1111 here")).toContain("[REDACTED:card]");
    expect(redactString("IBAN DE89370400440532013000 ok")).toContain("[REDACTED:iban]");
    expect(redactString("acct 123456789012 ok")).toContain("[REDACTED:account]");
    expect(redactString("acct 123456789012 ok")).not.toContain("123456789012");
  });
});

describe("redaction never corrupts UUIDs", () => {
  // node segment is all 12 digits — the account rule (\b\d{9,}\b) used to eat it
  const allDigitNode = "550e8400-e29b-41d4-a716-446655440000";
  // a digit run spans the dash and is Luhn-valid — the card rule used to eat it
  const cardLikeRun = "11111111-2222-4333-8444-123456789012";
  // ordinary mixed-hex id — was always safe; guards against over-eager masking
  const mixed = "abcdef01-2345-4678-9abc-deadbeef0123";

  for (const id of [allDigitNode, cardLikeRun, mixed]) {
    test(`survives byte-identical: ${id}`, () => {
      expect(redactString(id)).toBe(id);
      expect(redactString(`see ${id} for details`)).toBe(`see ${id} for details`);
    });
  }

  test("a UUID and an adjacent real account number are handled independently", () => {
    const out = redactString(`id ${allDigitNode} acct 999999999999`);
    expect(out).toContain(allDigitNode); // id preserved
    expect(out).toContain("[REDACTED:account]"); // real secret still scrubbed
    expect(out).not.toContain("999999999999");
  });

  test("redactDeep preserves ids in nested envelope shapes", () => {
    const env = {
      data: { decision_id: allDigitNode },
      sources: [{ type: "decision", id: cardLikeRun }],
    };
    expect(redactDeep(env)).toEqual(env);
  });
});
