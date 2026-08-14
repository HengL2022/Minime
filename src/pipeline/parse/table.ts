// Shared markdown tables for csv/xlsx. Caps keep classify payloads small.

export const MAX_TABLE_ROWS = 200;
export const MAX_TABLE_COLS = 16;

function escapeCell(value: string): string {
  return value.replace(/\r\n/g, "\n").replace(/\n/g, " ").replace(/\|/g, "\\|");
}

export function markdownTable(rows: string[][]): string {
  const capped = rows.slice(0, MAX_TABLE_ROWS).map((row) => row.slice(0, MAX_TABLE_COLS));
  if (capped.length === 0) return "";
  const width = Math.max(1, ...capped.map((row) => row.length));
  const norm = capped.map((row) =>
    Array.from({ length: width }, (_, i) => escapeCell(row[i] ?? "")),
  );
  const head = norm[0]!;
  const lines = [
    `| ${head.join(" | ")} |`,
    `| ${head.map(() => "---").join(" | ")} |`,
    ...norm.slice(1).map((row) => `| ${row.join(" | ")} |`),
  ];
  return lines.join("\n");
}
