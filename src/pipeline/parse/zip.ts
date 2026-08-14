// Local-header ZIP reader for OOXML. Stored + deflate only; zip64, encryption,
// and path `..` fail closed so inbox bytes never escape via archive tricks.

import { inflateRawSync } from "node:zlib";

export class ZipReadError extends Error {
  constructor() {
    super("zip_failed");
    this.name = "ZipReadError";
  }
}

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_EOCD64 = 0x06064b50;
const ZIP64_SIZE = 0xffffffff;
const FLAG_ENCRYPTED = 0x0001;
const FLAG_DATA_DESC = 0x0008;
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;
const MAX_ZIP_ENTRY = 8 * 1024 * 1024;

interface ZipLocal {
  name: string;
  method: number;
  compSize: number;
  uncompSize: number;
  dataStart: number;
  next: number;
}

function fail(): never {
  throw new ZipReadError();
}

function u16(buf: Buffer, i: number): number {
  if (i + 2 > buf.length) fail();
  return buf[i]! | (buf[i + 1]! << 8);
}

function u32(buf: Buffer, i: number): number {
  if (i + 4 > buf.length) fail();
  return (buf[i]! | (buf[i + 1]! << 8) | (buf[i + 2]! << 16) | (buf[i + 3]! << 24)) >>> 0;
}

function isEndSig(sig: number): boolean {
  return sig === SIG_CENTRAL || sig === SIG_EOCD || sig === SIG_EOCD64;
}

function assertSafeName(name: string): void {
  if (name.replace(/\\/g, "/").split("/").includes("..")) fail();
}

function extraHasZip64(extra: Buffer): boolean {
  let i = 0;
  while (i + 4 <= extra.length) {
    const id = extra[i]! | (extra[i + 1]! << 8);
    const size = extra[i + 2]! | (extra[i + 3]! << 8);
    if (id === 1) return true;
    i += 4 + size;
    if (i > extra.length) fail();
  }
  return false;
}

function readLocal(buf: Buffer, offset: number): ZipLocal {
  if (u32(buf, offset) !== SIG_LOCAL) fail();
  const flags = u16(buf, offset + 6);
  const method = u16(buf, offset + 8);
  const compSize = u32(buf, offset + 18);
  const uncompSize = u32(buf, offset + 22);
  const nameLen = u16(buf, offset + 26);
  const extraLen = u16(buf, offset + 28);
  const nameStart = offset + 30;
  const extraStart = nameStart + nameLen;
  const dataStart = extraStart + extraLen;
  if (dataStart > buf.length) fail();
  if (flags & FLAG_ENCRYPTED) fail();
  if (compSize === ZIP64_SIZE || uncompSize === ZIP64_SIZE) fail();
  if (flags & FLAG_DATA_DESC && compSize === 0) fail();
  if (uncompSize > MAX_ZIP_ENTRY || compSize > MAX_ZIP_ENTRY) fail();
  if (extraHasZip64(buf.subarray(extraStart, extraStart + extraLen))) fail();
  const name = buf.toString("utf8", nameStart, nameStart + nameLen).replace(/\\/g, "/");
  assertSafeName(name);
  const next = dataStart + compSize;
  if (next > buf.length) fail();
  return { name, method, compSize, uncompSize, dataStart, next };
}

function listZipLocals(bytes: Uint8Array): ZipLocal[] {
  const buf = Buffer.from(bytes);
  const locals: ZipLocal[] = [];
  let i = 0;
  while (i + 4 <= buf.length) {
    const sig = u32(buf, i);
    if (isEndSig(sig)) break;
    const local = readLocal(buf, i);
    locals.push(local);
    i = local.next;
  }
  if (locals.length === 0) fail();
  return locals;
}

export function zipEntryNames(bytes: Uint8Array): string[] {
  return listZipLocals(bytes).map((entry) => entry.name);
}

function inflateEntry(buf: Buffer, local: ZipLocal): Uint8Array {
  const slice = buf.subarray(local.dataStart, local.dataStart + local.compSize);
  if (local.method === METHOD_STORE) {
    if (slice.length !== local.uncompSize) fail();
    return slice;
  }
  if (local.method !== METHOD_DEFLATE) fail();
  try {
    const out = inflateRawSync(slice, { maxOutputLength: local.uncompSize });
    if (out.length !== local.uncompSize) fail();
    return out;
  } catch {
    fail();
  }
}

export function zipReadFile(bytes: Uint8Array, name: string): Uint8Array {
  const want = name.replace(/\\/g, "/");
  const local = listZipLocals(bytes).find((entry) => entry.name === want);
  if (!local) fail();
  return inflateEntry(Buffer.from(bytes), local);
}
