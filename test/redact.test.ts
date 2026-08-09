// Outbound redaction (spec §8) must scrub cards/IBANs/account numbers from every string
// leaving the server WITHOUT mangling server-generated UUIDs. A v4 UUID's all-digit node
// segment (~0.35% of ids) and Luhn-valid digit runs spanning its dashes used to be eaten by
// the account/card rules, corrupting returned ids and breaking the one-door contract where
// agents re-pass them (intermittent CI flake, 2026-06-15). Fully offline; fixtures fictional.

import { describe, expect, test } from "bun:test";
import type { AuditSink, DurableResultAudit } from "../src/mcp/audit";
import { ToolError, envelope } from "../src/mcp/envelope";
import { redactDeep, redactString } from "../src/mcp/redact";
import { type ToolDef, executeTool, invokeTool } from "../src/mcp/tools/registry";
import { config } from "../src/util/config";

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

describe("W4-10: bare 9+ digit rule is context-gated", () => {
  test("a Chinese mobile number and a US mobile number survive with no account context nearby", () => {
    // 11-digit CN mobile shape
    expect(redactString("call me at 13800138000 tonight")).toContain("13800138000");
    // 10-digit US mobile shape
    expect(redactString("my number is 4155551234, call anytime")).toContain("4155551234");
  });

  test("an epoch-shaped bare digit run survives with no account context nearby", () => {
    expect(redactString("last synced at 1719811200")).toContain("1719811200");
  });

  test("a courier tracking number survives with no account context nearby", () => {
    expect(redactString("tracking 123456789012 shipped today")).toContain("123456789012");
    expect(redactString("parcel ref 987654321098 left the depot")).toContain("987654321098");
  });

  test("'account 123456789' still redacts (English context word within range)", () => {
    expect(redactString("account 123456789")).toContain("[REDACTED:account]");
    expect(redactString("account 123456789")).not.toContain("123456789");
  });

  test("other English context words (acct, iban, routing, swift, a/c) also gate the rule", () => {
    expect(redactString("acct 123456789")).toContain("[REDACTED:account]");
    expect(redactString("a/c 123456789")).toContain("[REDACTED:account]");
    expect(redactString("routing 123456789")).toContain("[REDACTED:account]");
    expect(redactString("please quote swift and ref 123456789")).toContain("[REDACTED:account]");
  });

  test("CJK account-context words (账号/账户/卡号) gate the rule too", () => {
    expect(redactString("账号 123456789")).toContain("[REDACTED:account]");
    expect(redactString("账号 123456789")).not.toContain("123456789");
    expect(redactString("我的账户是111222333，请核对")).toContain("[REDACTED:account]");
    expect(redactString("银行卡号: 123456789012")).toContain("[REDACTED:account]");
  });

  test("a context word more than 40 chars away no longer gates the match", () => {
    // "account" then 43 spaces of padding (> BARE_DIGIT_CONTEXT_RADIUS) before the digits
    const farAway = `${"account".padEnd(50, " ")}123456789`;
    expect(redactString(farAway)).toContain("123456789");
    expect(redactString(farAway)).not.toContain("[REDACTED:account]");
  });

  test("IBAN and separated Luhn card redact unconditionally — no context word needed", () => {
    expect(redactString("4111-1111-1111-1111")).toContain("[REDACTED:card]");
    expect(redactString("4111-1111-1111-1111")).not.toContain("4111-1111-1111-1111");
    expect(redactString("DE89370400440532013000")).toContain("[REDACTED:iban]");
  });

  test("an unrelated bare digit run near a redacted IBAN survives — the [REDACTED:iban] placeholder's own 'iban' substring must not gate it", () => {
    // Regression: the bare-digit context check used to test against the progressively-redacted
    // string, so "[REDACTED:iban]" (which contains the trigger word "iban") falsely gated any
    // unrelated 9+ digit run within 40 chars of a redacted IBAN, even with zero context words in
    // the original text.
    const out = redactString(
      "Sent DE89370400440532013000 for rent, fyi order 555666777 shipped separately",
    );
    expect(out).toContain("[REDACTED:iban]");
    expect(out).toContain("555666777");
    expect(out).not.toContain("[REDACTED:account]");
  });
});

describe("W4-10: owner allowlist (REDACT_ALLOWLIST) exempts declared numbers from every rule", () => {
  test("an allowlisted Luhn-valid card number survives; the same string absent from the allowlist redacts", () => {
    const original = config.redactAllowlist;
    try {
      config.redactAllowlist = new Set(["4111111111111111"]);
      expect(redactString("card 4111 1111 1111 1111 on file")).toContain("4111 1111 1111 1111");
      expect(redactString("card 4111 1111 1111 1111 on file")).not.toContain("[REDACTED");

      config.redactAllowlist = new Set();
      expect(redactString("card 4111 1111 1111 1111 on file")).toContain("[REDACTED:card]");
      expect(redactString("card 4111 1111 1111 1111 on file")).not.toContain("4111 1111 1111 1111");
    } finally {
      config.redactAllowlist = original;
    }
  });

  test("the allowlist also exempts a bare digit run that context would otherwise redact", () => {
    const original = config.redactAllowlist;
    try {
      config.redactAllowlist = new Set(["123456789012"]);
      expect(redactString("acct 123456789012 ok")).toContain("123456789012");
      expect(redactString("acct 123456789012 ok")).not.toContain("[REDACTED");
    } finally {
      config.redactAllowlist = original;
    }
  });
});

describe("W4-10: outbound redaction count is disclosed in envelope gaps", () => {
  test("a tool result containing one redaction carries the count gap", async () => {
    const tool: ToolDef = {
      name: "fictional_redaction_probe_single",
      description: "fictional",
      schema: {},
      handler: async () => envelope({ note: "please debit account 123456789" }, []),
    };
    const result = await executeTool(tool, {}, { actor: "agent:redact-test" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The context word itself ("account") is only a gate, never consumed — only the digit run
    // is replaced.
    expect(result.envelope.data).toEqual({ note: "please debit account [REDACTED:account]" });
    expect(result.envelope.gaps).toEqual(["outbound redaction replaced 1 number-like string"]);
  });

  test("a tool result containing several redactions carries the plural count gap", async () => {
    const tool: ToolDef = {
      name: "fictional_redaction_probe_multi",
      description: "fictional",
      schema: {},
      handler: async () =>
        envelope({ note: "card 4111 1111 1111 1111 and account 123456789 on file" }, []),
    };
    const result = await executeTool(tool, {}, { actor: "agent:redact-test" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.envelope.gaps).toEqual(["outbound redaction replaced 2 number-like strings"]);
  });

  test("no gap is appended when nothing was redacted", async () => {
    const tool: ToolDef = {
      name: "fictional_redaction_probe_none",
      description: "fictional",
      schema: {},
      handler: async () => envelope({ note: "nothing sensitive here, call 4155551234" }, []),
    };
    const result = await executeTool(tool, {}, { actor: "agent:redact-test" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.envelope.data).toEqual({ note: "nothing sensitive here, call 4155551234" });
    expect(result.envelope.gaps).toBeUndefined();
  });

  test("a redaction count gap is appended alongside a handler's own gaps, not in place of them", async () => {
    const tool: ToolDef = {
      name: "fictional_redaction_probe_with_own_gap",
      description: "fictional",
      schema: {},
      handler: async () =>
        envelope({ note: "account 123456789" }, [], { gaps: ["handler-reported gap"] }),
    };
    const result = await executeTool(tool, {}, { actor: "agent:redact-test" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.envelope.gaps).toEqual([
      "handler-reported gap",
      "outbound redaction replaced 1 number-like string",
    ]);
  });

  test("end-to-end through invokeTool (audit-wrapped path), the count gap still reaches the caller", async () => {
    const tool: ToolDef = {
      name: "fictional_redaction_probe_invoke",
      description: "fictional",
      schema: {},
      handler: async () => envelope({ note: "iban DE89370400440532013000 on file" }, []),
    };
    // eventAuditSink (invokeTool's default) writes verb `tool:<name>:attempt` and rejects any
    // tool name outside AUDITED_TOOL_NAMES (util/audit-payload.ts) -- fine for real MCP tools,
    // not for a fictional one, so a minimal stand-in sink exercises the exact same invokeTool ->
    // executeTool -> redactDeepCounted wiring without that unrelated constraint (same approach
    // as m6.leak.test.ts's RecordingSink).
    const fictionalAuditSink: AuditSink = {
      async attempt() {
        return "fictional-hash";
      },
      async result(): Promise<DurableResultAudit> {
        return { eventId: "fictional-event-id" };
      },
      async disposition() {},
    };
    const result = await invokeTool(tool, {}, { actor: "agent:redact-test" }, fictionalAuditSink);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.envelope.data).toEqual({ note: "iban [REDACTED:iban] on file" });
    expect(result.envelope.gaps).toEqual(["outbound redaction replaced 1 number-like string"]);
  });

  test("the error path still redacts the message but never invents a gaps array (errors have none)", async () => {
    const tool: ToolDef = {
      name: "fictional_redaction_probe_error",
      description: "fictional",
      schema: {},
      handler: async () => {
        // ToolError messages pass through as-is (registry.ts) — unlike a plain Error, which
        // gets the fixed opaque "Internal tool error." wire message instead. This is the path
        // that actually exercises redactDeepCounted(message) on the error branch.
        throw new ToolError("BAD_INPUT", "account 123456789 is not a valid reference");
      },
    };
    const result = await executeTool(tool, {}, { actor: "agent:redact-test" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("BAD_INPUT");
    expect(result.error.message).toBe("account [REDACTED:account] is not a valid reference");
    expect(result.error).not.toHaveProperty("gaps");
  });
});
