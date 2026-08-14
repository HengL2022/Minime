// W5 first slice: magic+ext parse registry, PDF golden, fail-closed unknowns.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  TIDEPOOL_SAMPLE,
  buildPdfWithContent,
  buildTextPdf,
  corruptPdfBytes,
  unknownBinaryBytes,
} from "../fixtures/parse/text-pdf";
import { InboxParseError, parseInboxSource } from "../src/pipeline/parse";

const expectedPath = join(import.meta.dir, "../fixtures/parse/tidepool-trays.expected.md");
const committedPdfPath = join(import.meta.dir, "../fixtures/parse/tidepool-trays.pdf");
const expectedMarkdown = readFileSync(expectedPath, "utf8").trim();

describe("parseInboxSource dispatch", () => {
  test("empty file is plain text, including a .pdf name", () => {
    expect(parseInboxSource("empty.pdf", new Uint8Array())).toEqual({
      markdown: "",
      mime: "text/plain",
      meta: { parser: "text" },
    });
  });

  test("%PDF magic wins over a .md extension", () => {
    const pdf = buildTextPdf(TIDEPOOL_SAMPLE);
    const parsed = parseInboxSource("note.md", pdf);
    expect(parsed.mime).toBe("application/pdf");
    expect(parsed.meta).toEqual({ parser: "pdf" });
    expect(parsed.markdown).toBe(expectedMarkdown);
  });

  test(".pdf extension without magic still uses the PDF parser", () => {
    try {
      parseInboxSource("note.pdf", Buffer.from("hello from a misnamed text file"));
      throw new Error("expected InboxParseError");
    } catch (error) {
      expect(error).toBeInstanceOf(InboxParseError);
      expect((error as InboxParseError).code).toBe("parse_failed");
      expect((error as InboxParseError).mime).toBe("application/pdf");
    }
  });

  test("utf8 .md and .txt passthrough keep their mime", () => {
    const body = "todo: label the fictional tidepool sample trays";
    expect(parseInboxSource("capture.md", Buffer.from(body))).toEqual({
      markdown: body,
      mime: "text/markdown",
      meta: { parser: "text" },
    });
    expect(parseInboxSource("capture.txt", Buffer.from(body))).toEqual({
      markdown: body,
      mime: "text/plain",
      meta: { parser: "text" },
    });
  });

  test("valid utf8 without a text extension is still text/plain", () => {
    const body = "Fictional tidepool sample trays";
    expect(parseInboxSource("notes.bin", Buffer.from(body)).mime).toBe("text/plain");
    expect(parseInboxSource("notes.bin", Buffer.from(body)).markdown).toBe(body);
  });
});

describe("PDF golden", () => {
  test("uncompressed generated PDF extracts the hand-written markdown", () => {
    const parsed = parseInboxSource("tidepool.pdf", buildTextPdf(expectedMarkdown));
    expect(parsed.markdown).toBe(expectedMarkdown);
    expect(parsed.mime).toBe("application/pdf");
  });

  test("committed golden PDF extracts the same markdown", () => {
    const bytes = readFileSync(committedPdfPath);
    expect(parseInboxSource("tidepool-trays.pdf", bytes).markdown).toBe(expectedMarkdown);
  });

  test("FlateDecode PDF extracts the same text", () => {
    const parsed = parseInboxSource(
      "tidepool.pdf",
      buildTextPdf(expectedMarkdown, { flate: true }),
    );
    expect(parsed.markdown).toBe(expectedMarkdown);
  });

  test("TJ fragments and literal escapes join into one line", () => {
    const content = "BT\n[(Fictional ) 20 (tidepool \\(sample\\) trays)] TJ\nET\n";
    const parsed = parseInboxSource("joined.pdf", buildPdfWithContent(content));
    expect(parsed.markdown).toBe("Fictional tidepool (sample) trays");
  });
});

describe("parse failures stay typed", () => {
  test("corrupt PDF throws parse_failed and never mentions file bytes", () => {
    const bytes = corruptPdfBytes();
    try {
      parseInboxSource("broken.pdf", bytes);
      throw new Error("expected InboxParseError");
    } catch (error) {
      expect(error).toBeInstanceOf(InboxParseError);
      const typed = error as InboxParseError;
      expect(typed.code).toBe("parse_failed");
      expect(typed.mime).toBe("application/pdf");
      expect(typed.message).toBe("parse_failed");
      expect(String(typed)).not.toContain("readable content stream");
    }
  });

  test("unknown binary throws unsupported_type", () => {
    try {
      parseInboxSource("photo.bin", unknownBinaryBytes());
      throw new Error("expected InboxParseError");
    } catch (error) {
      expect(error).toBeInstanceOf(InboxParseError);
      expect((error as InboxParseError).code).toBe("unsupported_type");
      expect((error as InboxParseError).mime).toBe("application/octet-stream");
    }
  });

  test("NUL bytes are not silently decoded as utf8", () => {
    try {
      parseInboxSource("notes.md", Buffer.from("ok\x00binary"));
      throw new Error("expected InboxParseError");
    } catch (error) {
      expect((error as InboxParseError).code).toBe("unsupported_type");
    }
  });
});
