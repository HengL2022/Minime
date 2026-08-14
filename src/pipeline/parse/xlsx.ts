// Proving XLSX extractor: shared strings + first sheets as markdown tables.
// Caps rows so classify stays small. No formulas/charts.

import { InboxParseError } from "./error";
import { hasZipMagic } from "./sniff";
import { MAX_TABLE_COLS, MAX_TABLE_ROWS, markdownTable } from "./table";
import { type XmlBlock, xmlAttr, xmlBlocks, xmlTexts } from "./xml";
import { zipEntryNames, zipReadFile } from "./zip";

export const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

function xlsxFailed(): never {
  throw new InboxParseError("parse_failed", XLSX_MIME);
}

function decodeUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    xlsxFailed();
  }
}

export function looksLikeXlsx(bytes: Uint8Array): boolean {
  if (!hasZipMagic(bytes)) return false;
  try {
    const names = zipEntryNames(bytes);
    return names.includes("xl/workbook.xml") || names.includes("xl/sharedStrings.xml");
  } catch {
    return false;
  }
}

function parseSharedStrings(xml: string): string[] {
  return xmlBlocks(xml, "si").map((si) => xmlTexts(si.inner, "t"));
}

function colFromRef(ref: string): number {
  let n = 0;
  for (let i = 0; i < ref.length; i++) {
    const code = ref.charCodeAt(i);
    if (code < 65 || code > 90) break;
    n = n * 26 + (code - 64);
  }
  return Math.max(0, n - 1);
}

function cellText(cell: XmlBlock, shared: string[]): string {
  const kind = xmlAttr(cell.open, "t") ?? "n";
  if (kind === "s") {
    const idx = Number(xmlTexts(cell.inner, "v"));
    return Number.isInteger(idx) ? (shared[idx] ?? "") : "";
  }
  if (kind === "inlineStr") return xmlTexts(cell.inner, "t");
  if (kind === "b") return xmlTexts(cell.inner, "v") === "1" ? "true" : "false";
  if (kind === "e") return "";
  return xmlTexts(cell.inner, "v");
}

function sheetRows(sheetXml: string, shared: string[]): string[][] {
  const parsed: Map<number, string>[] = [];
  let maxCol = 0;
  for (const row of xmlBlocks(sheetXml, "row")) {
    if (parsed.length >= MAX_TABLE_ROWS) break;
    const cells = new Map<number, string>();
    let seq = 0;
    for (const cell of xmlBlocks(row.inner, "c")) {
      const ref = xmlAttr(cell.open, "r");
      const col = ref ? colFromRef(ref.toUpperCase()) : seq;
      seq++;
      if (col >= MAX_TABLE_COLS) continue;
      cells.set(col, cellText(cell, shared));
      if (col > maxCol) maxCol = col;
    }
    parsed.push(cells);
  }
  return parsed.map((cells) => Array.from({ length: maxCol + 1 }, (_, i) => cells.get(i) ?? ""));
}

function workbookSheets(xml: string): { name: string; rid: string }[] {
  const sheets: { name: string; rid: string }[] = [];
  for (const sheet of xmlBlocks(xml, "sheet")) {
    const name = xmlAttr(sheet.open, "name");
    const rid = xmlAttr(sheet.open, "r:id") ?? xmlAttr(sheet.open, "id");
    if (name && rid) sheets.push({ name, rid });
  }
  return sheets;
}

function worksheetTargets(xml: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const rel of xmlBlocks(xml, "Relationship")) {
    const id = xmlAttr(rel.open, "Id");
    const target = xmlAttr(rel.open, "Target");
    const type = xmlAttr(rel.open, "Type") ?? "";
    if (id && target && type.includes("worksheet")) map.set(id, target);
  }
  return map;
}

function resolveXlPath(target: string): string {
  const norm = target.replace(/\\/g, "/").replace(/^\.\//, "");
  if (norm.startsWith("/")) return norm.slice(1);
  return `xl/${norm}`;
}

function readXml(bytes: Uint8Array, names: string[], path: string): string | null {
  if (!names.includes(path)) return null;
  return decodeUtf8(zipReadFile(bytes, path));
}

function renderSheets(
  bytes: Uint8Array,
  names: string[],
  sheets: { name: string; rid: string }[],
  rels: Map<string, string>,
  shared: string[],
): string[] {
  const parts: string[] = [];
  for (const sheet of sheets.slice(0, 5)) {
    const target = rels.get(sheet.rid) ?? `worksheets/sheet${parts.length + 1}.xml`;
    const xml = readXml(bytes, names, resolveXlPath(target));
    if (!xml) continue;
    const rows = sheetRows(xml, shared);
    if (rows.length === 0) continue;
    const title = sheet.name.replace(/\s+/g, " ").trim() || "Sheet";
    parts.push(`## ${title}\n\n${markdownTable(rows)}`);
  }
  return parts;
}

export function extractXlsxMarkdown(bytes: Uint8Array): string {
  try {
    const names = zipEntryNames(bytes);
    const sharedXml = readXml(bytes, names, "xl/sharedStrings.xml");
    const shared = sharedXml ? parseSharedStrings(sharedXml) : [];
    const workbook = readXml(bytes, names, "xl/workbook.xml");
    if (!workbook) xlsxFailed();
    const relsXml = readXml(bytes, names, "xl/_rels/workbook.xml.rels");
    const parts = renderSheets(
      bytes,
      names,
      workbookSheets(workbook),
      relsXml ? worksheetTargets(relsXml) : new Map(),
      shared,
    );
    return parts.join("\n\n");
  } catch (error) {
    if (error instanceof InboxParseError) throw error;
    xlsxFailed();
  }
}
