// Deterministic fictional PDFs for the W5 parse golden. Not owner data.
import { deflateSync } from "node:zlib";

export const TIDEPOOL_SAMPLE = "Fictional tidepool sample trays";

function escapePdfLiteral(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

function totalLength(chunks: Buffer[]): number {
  return chunks.reduce((n, chunk) => n + chunk.length, 0);
}

export function buildPdfWithContent(content: string, opts?: { flate?: boolean }): Uint8Array {
  const contentBytes = Buffer.from(content, "latin1");
  const streamData = opts?.flate ? deflateSync(contentBytes) : contentBytes;
  const filter = opts?.flate ? " /Filter /FlateDecode" : "";
  const obj4 = Buffer.concat([
    Buffer.from(`<< /Length ${streamData.length}${filter} >>\nstream\n`, "latin1"),
    streamData,
    Buffer.from("\nendstream", "latin1"),
  ]);
  const bodies = [
    Buffer.from("<< /Type /Catalog /Pages 2 0 R >>", "latin1"),
    Buffer.from("<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "latin1"),
    Buffer.from(
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
      "latin1",
    ),
    obj4,
    Buffer.from("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>", "latin1"),
  ];
  const chunks: Buffer[] = [Buffer.from("%PDF-1.1\n", "latin1")];
  const offsets = [0];
  for (let i = 0; i < bodies.length; i++) {
    offsets.push(totalLength(chunks));
    chunks.push(
      Buffer.from(`${i + 1} 0 obj\n`, "latin1"),
      bodies[i]!,
      Buffer.from("\nendobj\n", "latin1"),
    );
  }
  const xrefAt = totalLength(chunks);
  const xref = ["xref", `0 ${bodies.length + 1}`, "0000000000 65535 f "];
  for (let i = 1; i <= bodies.length; i++) {
    xref.push(`${String(offsets[i]).padStart(10, "0")} 00000 n `);
  }
  chunks.push(
    Buffer.from(
      `${xref.join("\n")}\ntrailer\n<< /Size ${bodies.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`,
      "latin1",
    ),
  );
  return Buffer.concat(chunks);
}

export function buildTextPdf(text: string, opts?: { flate?: boolean }): Uint8Array {
  const content = `BT\n/F1 12 Tf\n72 720 Td\n(${escapePdfLiteral(text)}) Tj\nET\n`;
  return buildPdfWithContent(content, opts);
}

export function corruptPdfBytes(): Uint8Array {
  return Buffer.from("%PDF-1.4\n%\x00\x01\x02\xff not a readable content stream\n");
}

export function unknownBinaryBytes(): Uint8Array {
  return Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0xfe, 0x01]);
}
