// RFC4180-ish CSV → one markdown table. Quoted fields only; keep it boring.

import { InboxParseError } from "./error";
import { isValidUtf8Text } from "./sniff";
import { MAX_TABLE_ROWS, markdownTable } from "./table";

export const CSV_MIME = "text/csv";

function csvFailed(): never {
  throw new InboxParseError("parse_failed", CSV_MIME);
}

function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let i = 0;
  let quoted = false;
  const pushRow = () => {
    row.push(field);
    field = "";
    if (row.length > 1 || row.some((cell) => cell.length > 0)) rows.push(row);
    row = [];
  };
  while (i < text.length) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i += 2;
        continue;
      }
      if (ch === '"') {
        quoted = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"') {
      quoted = true;
      i++;
      continue;
    }
    if (ch === ",") {
      row.push(field);
      field = "";
      i++;
      continue;
    }
    if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      pushRow();
      if (rows.length >= MAX_TABLE_ROWS) return rows;
      i++;
      continue;
    }
    field += ch;
    i++;
  }
  if (quoted) csvFailed();
  if (field.length > 0 || row.length > 0) pushRow();
  return rows;
}

export function extractCsvMarkdown(bytes: Uint8Array): string {
  if (!isValidUtf8Text(bytes)) csvFailed();
  const text = new TextDecoder("utf-8").decode(bytes).replace(/^\uFEFF/, "");
  return markdownTable(parseCsvRows(text));
}
