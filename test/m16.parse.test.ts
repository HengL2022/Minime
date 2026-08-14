// W5 parse registry: magic+ext dispatch, PDF/office/mail goldens, fail-closed unknowns.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  COBALT_KILN_CSV_MD,
  COBALT_KILN_XLSX_MD,
  COPPER_GARDEN_BODY,
  COPPER_GARDEN_DOCX_MD,
  COPPER_GARDEN_EML_MD,
  COPPER_GARDEN_TITLE,
  buildCobaltKilnCsv,
  buildCobaltKilnXlsx,
  buildCopperGardenDocx,
  buildCopperGardenEml,
  buildCsv,
  buildDocx,
  buildEml,
  buildXlsx,
  buildZip,
  corruptOfficeBytes,
  notRfc822Bytes,
} from "../fixtures/parse/office-mail";
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
const fixture = (name: string) => join(import.meta.dir, "../fixtures/parse", name);

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

function expectParseFailed(path: string, bytes: Uint8Array, mime: string, hidden?: string) {
  try {
    parseInboxSource(path, bytes);
    throw new Error("expected InboxParseError");
  } catch (error) {
    expect(error).toBeInstanceOf(InboxParseError);
    const typed = error as InboxParseError;
    expect(typed.code).toBe("parse_failed");
    expect(typed.mime).toBe(mime);
    expect(typed.message).toBe("parse_failed");
    if (hidden) expect(String(typed)).not.toContain(hidden);
  }
}

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
    expectParseFailed(
      "note.pdf",
      Buffer.from("hello from a misnamed text file"),
      "application/pdf",
    );
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

  test("docx magic wins over a .xlsx extension", () => {
    const parsed = parseInboxSource("notes.xlsx", buildCopperGardenDocx());
    expect(parsed.mime).toBe(DOCX_MIME);
    expect(parsed.meta).toEqual({ parser: "docx" });
    expect(parsed.markdown).toBe(COPPER_GARDEN_DOCX_MD);
  });

  test("xlsx magic wins over a .csv extension", () => {
    const parsed = parseInboxSource("notes.csv", buildCobaltKilnXlsx());
    expect(parsed.mime).toBe(XLSX_MIME);
    expect(parsed.meta).toEqual({ parser: "xlsx" });
    expect(parsed.markdown).toBe(COBALT_KILN_XLSX_MD);
  });

  test("rfc822 magic wins over a .txt extension", () => {
    const parsed = parseInboxSource("notes.txt", Buffer.from(buildCopperGardenEml()));
    expect(parsed.mime).toBe("message/rfc822");
    expect(parsed.meta).toEqual({ parser: "eml" });
    expect(parsed.markdown).toBe(COPPER_GARDEN_EML_MD);
  });

  test("a todo that mentions From and Date stays text, not eml", () => {
    const body = [
      "todo: call the kiln supplier",
      "From: last week copper-garden note",
      "Date: Friday",
      "",
      "Need the trays labeled.",
    ].join("\n");
    const parsed = parseInboxSource("capture.txt", Buffer.from(body));
    expect(parsed.mime).toBe("text/plain");
    expect(parsed.meta).toEqual({ parser: "text" });
    expect(parsed.markdown).toBe(body);
  });

  test("valid utf8 .csv uses the csv parser, not text/plain", () => {
    const parsed = parseInboxSource("trays.csv", Buffer.from(buildCobaltKilnCsv()));
    expect(parsed.mime).toBe("text/csv");
    expect(parsed.meta).toEqual({ parser: "csv" });
    expect(parsed.markdown).toBe(COBALT_KILN_CSV_MD);
  });

  test("extension without magic still selects the office/eml parser", () => {
    expectParseFailed("note.docx", Buffer.from("hello from a misnamed text file"), DOCX_MIME);
    expectParseFailed("note.xlsx", Buffer.from("hello from a misnamed text file"), XLSX_MIME);
    expectParseFailed("note.eml", notRfc822Bytes(), "message/rfc822");
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

describe("office and mail goldens", () => {
  test("generated and committed docx extract the same markdown", () => {
    const generated = parseInboxSource("copper-garden.docx", buildCopperGardenDocx());
    const committed = parseInboxSource(
      "copper-garden.docx",
      readFileSync(fixture("copper-garden.docx")),
    );
    expect(generated.markdown).toBe(COPPER_GARDEN_DOCX_MD);
    expect(committed.markdown).toBe(
      readFileSync(fixture("copper-garden.docx.expected.md"), "utf8").trim(),
    );
    expect(generated.markdown).toBe(committed.markdown);
  });

  test("deflated docx still extracts paragraph text", () => {
    const parsed = parseInboxSource("copper-garden.docx", buildCopperGardenDocx({ deflate: true }));
    expect(parsed.markdown).toBe(COPPER_GARDEN_DOCX_MD);
  });

  test("generated and committed xlsx extract the same markdown table", () => {
    const generated = parseInboxSource("cobalt-kiln.xlsx", buildCobaltKilnXlsx());
    const committed = parseInboxSource(
      "cobalt-kiln.xlsx",
      readFileSync(fixture("cobalt-kiln.xlsx")),
    );
    expect(generated.markdown).toBe(COBALT_KILN_XLSX_MD);
    expect(committed.markdown).toBe(
      readFileSync(fixture("cobalt-kiln.xlsx.expected.md"), "utf8").trim(),
    );
    expect(generated.markdown).toBe(committed.markdown);
  });

  test("generated and committed csv extract the same markdown table", () => {
    const generated = parseInboxSource("cobalt-kiln.csv", Buffer.from(buildCobaltKilnCsv()));
    const committed = parseInboxSource("cobalt-kiln.csv", readFileSync(fixture("cobalt-kiln.csv")));
    expect(generated.markdown).toBe(COBALT_KILN_CSV_MD);
    expect(committed.markdown).toBe(
      readFileSync(fixture("cobalt-kiln.csv.expected.md"), "utf8").trim(),
    );
    expect(generated.markdown).toBe(committed.markdown);
  });

  test("quoted csv fields keep commas inside one cell", () => {
    const csv = buildCsv([
      ["plot", "note"],
      ["north", "kelp, then cobalt moss"],
    ]);
    const parsed = parseInboxSource("notes.csv", Buffer.from(csv));
    expect(parsed.markdown).toContain("| north | kelp, then cobalt moss |");
  });

  test("generated and committed eml extract headers plus plain body", () => {
    const generated = parseInboxSource("copper-garden.eml", Buffer.from(buildCopperGardenEml()));
    const committed = parseInboxSource(
      "copper-garden.eml",
      readFileSync(fixture("copper-garden.eml")),
    );
    expect(generated.markdown).toBe(COPPER_GARDEN_EML_MD);
    expect(committed.markdown).toBe(
      readFileSync(fixture("copper-garden.eml.expected.md"), "utf8").trim(),
    );
    expect(generated.markdown).toBe(committed.markdown);
  });

  test("multipart/alternative prefers text/plain and skips html", () => {
    const eml = buildEml({
      subject: COPPER_GARDEN_TITLE,
      from: "ada@tidepool.example",
      date: "Fri, 14 Aug 2026 12:00:00 +0000",
      contentType: 'multipart/alternative; boundary="bound"',
      encoding: "7bit",
      body: `--bound
Content-Type: text/plain; charset="utf-8"

${COPPER_GARDEN_BODY}
--bound
Content-Type: text/html; charset="utf-8"

<p>ignore the kiln html</p>
--bound--
`,
    });
    const parsed = parseInboxSource("note.eml", Buffer.from(eml));
    expect(parsed.markdown).toContain(COPPER_GARDEN_BODY);
    expect(parsed.markdown).not.toContain("ignore the kiln html");
  });

  test("quoted-printable utf-8 text/plain decodes", () => {
    const eml = buildEml({
      subject: COPPER_GARDEN_TITLE,
      from: "ada@tidepool.example",
      date: "Fri, 14 Aug 2026 12:00:00 +0000",
      encoding: "quoted-printable",
      body: "Tidepool trays need a second label pass=2E",
    });
    expect(parseInboxSource("note.eml", Buffer.from(eml)).markdown).toContain(COPPER_GARDEN_BODY);
  });

  test("xlsx row cap keeps classify payloads small", () => {
    const rows = [["plot"], ...Array.from({ length: 220 }, (_, i) => [`tray-${i}`])];
    const parsed = parseInboxSource("many.xlsx", buildXlsx([{ name: "Trays", rows }]));
    expect(parsed.markdown.split("\n").filter((line) => line.startsWith("| tray-"))).toHaveLength(
      199,
    );
  });
});

describe("parse failures stay typed", () => {
  test("corrupt PDF throws parse_failed and never mentions file bytes", () => {
    expectParseFailed(
      "broken.pdf",
      corruptPdfBytes(),
      "application/pdf",
      "readable content stream",
    );
  });

  test("corrupt office and eml throw parse_failed without capture bytes", () => {
    expectParseFailed("broken.docx", corruptOfficeBytes(), DOCX_MIME, "readable office package");
    expectParseFailed("broken.xlsx", corruptOfficeBytes(), XLSX_MIME, "readable office package");
    expectParseFailed("broken.eml", notRfc822Bytes(), "message/rfc822", "tidepool note");
    expectParseFailed("broken.csv", Buffer.from("ok\x00binary"), "text/csv");
  });

  test("an .eml with no mail headers or body fails closed", () => {
    expectParseFailed("note.eml", Buffer.from("todo: label the fictional trays"), "message/rfc822");
  });

  test("html-only eml fails closed", () => {
    const eml = buildEml({
      subject: COPPER_GARDEN_TITLE,
      from: "ada@tidepool.example",
      date: "Fri, 14 Aug 2026 12:00:00 +0000",
      contentType: 'text/html; charset="utf-8"',
      body: "<p>kiln html only</p>",
    });
    expectParseFailed("note.eml", Buffer.from(eml), "message/rfc822", "kiln html only");
  });

  test("attachments and raw base64 stay out of markdown", () => {
    const blob = "VGhpcyBtdXN0IG5vdCByZWFjaCBtYXJrZG93bi4=";
    const eml = buildEml({
      subject: COPPER_GARDEN_TITLE,
      from: "ada@tidepool.example",
      date: "Fri, 14 Aug 2026 12:00:00 +0000",
      contentType: 'multipart/mixed; boundary="mix"',
      encoding: "7bit",
      body: `--mix
Content-Type: text/plain; charset="utf-8"

${COPPER_GARDEN_BODY}
--mix
Content-Type: application/pdf
Content-Transfer-Encoding: base64
Content-Disposition: attachment; filename="kiln.pdf"

${blob}
--mix--
`,
    });
    const parsed = parseInboxSource("note.eml", Buffer.from(eml));
    expect(parsed.markdown).toContain(COPPER_GARDEN_BODY);
    expect(parsed.markdown).not.toContain(blob);
    expect(parsed.markdown).not.toContain("must not reach");
  });

  test("zip encryption, zip64 sizes, and path .. fail closed", () => {
    expectParseFailed("note.docx", buildCopperGardenDocx({ encryptFlag: true }), DOCX_MIME);
    const traversal = buildZip([
      { name: "[Content_Types].xml", data: Buffer.from("<Types/>", "utf8") },
      { name: "../word/document.xml", data: Buffer.from("<w:document/>", "utf8") },
    ]);
    expectParseFailed("note.docx", traversal, DOCX_MIME);
    const zip64 = Buffer.from(buildDocx([COPPER_GARDEN_TITLE]));
    zip64.writeUInt32LE(0xffffffff, 22);
    expectParseFailed("note.docx", zip64, DOCX_MIME);
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
