// Deterministic fictional OOXML / CSV / RFC822 bytes for W5 parse goldens.
// Tidepool / copper garden / cobalt kiln only — not owner data.

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";

export const COPPER_GARDEN_TITLE = "Copper garden kiln notes";
export const COPPER_GARDEN_BODY = "Tidepool trays need a second label pass.";
export const COBALT_KILN_SHEET = "Trays";
export const COBALT_KILN_ROWS = [
  ["plot", "crop", "count"],
  ["north", "kelp", "4"],
  ["south", "cobalt moss", "2"],
];

export const COPPER_GARDEN_DOCX_MD = `${COPPER_GARDEN_TITLE}\n${COPPER_GARDEN_BODY}`;
export const COBALT_KILN_XLSX_MD = `## ${COBALT_KILN_SHEET}

| plot | crop | count |
| --- | --- | --- |
| north | kelp | 4 |
| south | cobalt moss | 2 |`;
export const COBALT_KILN_CSV_MD = `| plot | crop | count |
| --- | --- | --- |
| north | kelp | 4 |
| south | cobalt moss | 2 |`;
export const COPPER_GARDEN_EML_MD = `Subject: ${COPPER_GARDEN_TITLE}
From: Ada Tidepool <ada@tidepool.example>
Date: Fri, 14 Aug 2026 12:00:00 +0000

${COPPER_GARDEN_BODY}`;

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i]!;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function u16(n: number): Buffer {
  const buf = Buffer.alloc(2);
  buf.writeUInt16LE(n);
  return buf;
}

function u32(n: number): Buffer {
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(n);
  return buf;
}

export interface ZipBuildOpts {
  deflate?: boolean;
  encryptFlag?: boolean;
}

export function buildZip(
  files: { name: string; data: Uint8Array }[],
  opts?: ZipBuildOpts,
): Uint8Array {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const raw = Buffer.from(file.data);
    const stored = opts?.deflate ? deflateRawSync(raw) : raw;
    const method = opts?.deflate ? 8 : 0;
    const flags = opts?.encryptFlag ? 0x0001 : 0;
    const name = Buffer.from(file.name, "utf8");
    const local = Buffer.concat([
      u32(0x04034b50),
      u16(20),
      u16(flags),
      u16(method),
      u16(0),
      u16(0),
      u32(crc32(raw)),
      u32(stored.length),
      u32(raw.length),
      u16(name.length),
      u16(0),
      name,
      stored,
    ]);
    locals.push(local);
    centrals.push(
      Buffer.concat([
        u32(0x02014b50),
        u16(20),
        u16(20),
        u16(flags),
        u16(method),
        u16(0),
        u16(0),
        u32(crc32(raw)),
        u32(stored.length),
        u32(raw.length),
        u16(name.length),
        u16(0),
        u16(0),
        u16(0),
        u16(0),
        u32(0),
        u32(offset),
        name,
      ]),
    );
    offset += local.length;
  }
  const central = Buffer.concat(centrals);
  const eocd = Buffer.concat([
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(files.length),
    u16(files.length),
    u32(central.length),
    u32(offset),
    u16(0),
  ]);
  return Buffer.concat([...locals, central, eocd]);
}

function xmlEscape(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function buildDocx(paragraphs: string[], opts?: ZipBuildOpts): Uint8Array {
  const paras = paragraphs
    .map((text) => `<w:p><w:r><w:t>${xmlEscape(text)}</w:t></w:r></w:p>`)
    .join("");
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paras}</w:body></w:document>`;
  const types = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`;
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;
  return buildZip(
    [
      { name: "[Content_Types].xml", data: Buffer.from(types, "utf8") },
      { name: "_rels/.rels", data: Buffer.from(rels, "utf8") },
      { name: "word/document.xml", data: Buffer.from(document, "utf8") },
    ],
    opts,
  );
}

function sharedStringXml(values: string[]): string {
  const items = values.map((value) => `<si><t>${xmlEscape(value)}</t></si>`).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${values.length}" uniqueCount="${values.length}">${items}</sst>`;
}

function colLetter(index: number): string {
  let n = index + 1;
  let out = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

function sheetXml(rows: string[][], shared: string[]): string {
  const body = rows
    .map((row, r) => {
      const cells = row
        .map((value, c) => {
          const ref = `${colLetter(c)}${r + 1}`;
          if (/^-?\d+(\.\d+)?$/.test(value)) return `<c r="${ref}"><v>${value}</v></c>`;
          return `<c r="${ref}" t="s"><v>${shared.indexOf(value)}</v></c>`;
        })
        .join("");
      return `<row r="${r + 1}">${cells}</row>`;
    })
    .join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${body}</sheetData></worksheet>`;
}

export function buildXlsx(
  sheets: { name: string; rows: string[][] }[],
  opts?: ZipBuildOpts,
): Uint8Array {
  const shared: string[] = [];
  for (const sheet of sheets) {
    for (const row of sheet.rows) {
      for (const value of row) {
        if (!/^-?\d+(\.\d+)?$/.test(value) && !shared.includes(value)) shared.push(value);
      }
    }
  }
  const sheetFiles = sheets.map((sheet, i) => ({
    name: `xl/worksheets/sheet${i + 1}.xml`,
    data: Buffer.from(sheetXml(sheet.rows, shared), "utf8"),
  }));
  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets
    .map(
      (sheet, i) =>
        `<sheet name="${xmlEscape(sheet.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`,
    )
    .join("")}</sheets></workbook>`;
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets
    .map(
      (_, i) =>
        `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
    )
    .join("")}</Relationships>`;
  const types = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${sheets
    .map(
      (_, i) =>
        `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
    )
    .join(
      "",
    )}<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>`;
  const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;
  return buildZip(
    [
      { name: "[Content_Types].xml", data: Buffer.from(types, "utf8") },
      { name: "_rels/.rels", data: Buffer.from(rootRels, "utf8") },
      { name: "xl/workbook.xml", data: Buffer.from(workbook, "utf8") },
      { name: "xl/_rels/workbook.xml.rels", data: Buffer.from(rels, "utf8") },
      { name: "xl/sharedStrings.xml", data: Buffer.from(sharedStringXml(shared), "utf8") },
      ...sheetFiles,
    ],
    opts,
  );
}

export function buildCsv(rows: string[][]): string {
  return rows
    .map((row) =>
      row.map((cell) => (/[",\n]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell)).join(","),
    )
    .join("\n");
}

export function buildEml(opts: {
  subject: string;
  from: string;
  date: string;
  body: string;
  contentType?: string;
  encoding?: string;
  extraHeaders?: string[];
}): string {
  const type = opts.contentType ?? 'text/plain; charset="utf-8"';
  const encoding = opts.encoding ?? "7bit";
  const extra = opts.extraHeaders?.length ? `${opts.extraHeaders.join("\n")}\n` : "";
  return `From: ${opts.from}
Date: ${opts.date}
Subject: ${opts.subject}
MIME-Version: 1.0
${extra}Content-Type: ${type}
Content-Transfer-Encoding: ${encoding}

${opts.body}
`;
}

export function buildCopperGardenDocx(opts?: ZipBuildOpts): Uint8Array {
  return buildDocx([COPPER_GARDEN_TITLE, COPPER_GARDEN_BODY], opts);
}

export function buildCobaltKilnXlsx(opts?: ZipBuildOpts): Uint8Array {
  return buildXlsx([{ name: COBALT_KILN_SHEET, rows: COBALT_KILN_ROWS }], opts);
}

export function buildCobaltKilnCsv(): string {
  return `${buildCsv(COBALT_KILN_ROWS)}\n`;
}

export function buildCopperGardenEml(): string {
  return buildEml({
    subject: COPPER_GARDEN_TITLE,
    from: "Ada Tidepool <ada@tidepool.example>",
    date: "Fri, 14 Aug 2026 12:00:00 +0000",
    body: COPPER_GARDEN_BODY,
  });
}

export function corruptOfficeBytes(): Uint8Array {
  return Buffer.from("PK\x03\x04\x00 not a readable office package\xff");
}

export function notRfc822Bytes(): Uint8Array {
  return Buffer.from("not an email, just a tidepool note\n");
}

if (import.meta.main) {
  const dir = import.meta.dir;
  writeFileSync(join(dir, "copper-garden.docx"), buildCopperGardenDocx());
  writeFileSync(join(dir, "copper-garden.docx.expected.md"), `${COPPER_GARDEN_DOCX_MD}\n`);
  writeFileSync(join(dir, "cobalt-kiln.xlsx"), buildCobaltKilnXlsx());
  writeFileSync(join(dir, "cobalt-kiln.xlsx.expected.md"), `${COBALT_KILN_XLSX_MD}\n`);
  writeFileSync(join(dir, "cobalt-kiln.csv"), buildCobaltKilnCsv());
  writeFileSync(join(dir, "cobalt-kiln.csv.expected.md"), `${COBALT_KILN_CSV_MD}\n`);
  writeFileSync(join(dir, "copper-garden.eml"), buildCopperGardenEml());
  writeFileSync(join(dir, "copper-garden.eml.expected.md"), `${COPPER_GARDEN_EML_MD}\n`);
}
