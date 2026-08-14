// Typed parse failures only. Message is the stable code so logs/audit never
// carry capture bytes or extracted text.

export type InboxParseCode = "unsupported_type" | "parse_failed";

export class InboxParseError extends Error {
  readonly code: InboxParseCode;
  readonly mime: string;

  constructor(code: InboxParseCode, mime: string) {
    super(code);
    this.name = "InboxParseError";
    this.code = code;
    this.mime = mime;
  }
}
