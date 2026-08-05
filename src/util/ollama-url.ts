import { isIP } from "node:net";

export type OllamaUrlRule =
  | "empty"
  | "control_character"
  | "endpoint_byte"
  | "surrounding_whitespace"
  | "syntax"
  | "scheme"
  | "credentials"
  | "authority_encoding"
  | "query_or_fragment"
  | "path_segment"
  | "port"
  | "ambiguous_numeric_host"
  | "non_loopback_host";

export class OllamaUrlError extends Error {
  readonly rule: OllamaUrlRule;

  constructor(rule: OllamaUrlRule) {
    super(`OLLAMA_URL is invalid for local Ollama (${rule}).`);
    this.name = "OllamaUrlError";
    this.rule = rule;
  }
}

export interface OllamaEndpoint {
  protocol: "http:" | "https:";
  hostname: string;
  connectHost: string;
  port: number;
  hostHeader: string;
  basePath: string;
  serverName?: string;
  canLaunchServer: boolean;
  bindAuthority: string;
}

function fail(rule: OllamaUrlRule): never {
  throw new OllamaUrlError(rule);
}

function rejectNonPrintableAscii(raw: string): void {
  for (const byte of Buffer.from(raw, "utf8")) {
    if (byte < 0x21 || byte > 0x7e) fail("endpoint_byte");
  }
}

function parsePort(raw: string | undefined, protocol: "http:" | "https:"): number {
  if (raw === undefined) return protocol === "http:" ? 80 : 443;
  if (!/^\d+$/.test(raw)) fail("port");
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) fail("port");
  return port;
}

function canonicalIpv4(raw: string): string {
  if (!/^[0-9.]+$/.test(raw)) fail("non_loopback_host");
  const parts = raw.split(".");
  if (parts.length !== 4) fail("ambiguous_numeric_host");
  for (const part of parts) {
    if (!/^(0|[1-9][0-9]{0,2})$/.test(part)) fail("ambiguous_numeric_host");
    if (Number(part) > 255) fail("ambiguous_numeric_host");
  }
  if (parts[0] !== "127") fail("non_loopback_host");
  return parts.join(".");
}

function numericLooking(raw: string): boolean {
  return (
    /^[0-9]+$/.test(raw) ||
    /^0x[0-9a-f]+$/i.test(raw) ||
    /^[0-9.]+$/.test(raw) ||
    /^0[0-7.]+$/.test(raw)
  );
}

function preparseRawPath(rawPath: string): void {
  if (rawPath.includes("\\")) fail("path_segment");
  let segment = "";
  for (let index = 0; index < rawPath.length; index += 1) {
    const char = rawPath[index]!;
    if (char === "%" && /^[0-9a-fA-F]{2}$/.test(rawPath.slice(index + 1, index + 3))) {
      const byte = rawPath.slice(index + 1, index + 3).toLowerCase();
      if (byte === "2f" || byte === "5c") fail("path_segment");
      if (byte === "2e") fail("path_segment");
    }
    if (char === "/") {
      if (segment === "." || segment === "..") fail("path_segment");
      segment = "";
    } else {
      segment += char;
    }
  }
  if (segment === "." || segment === "..") fail("path_segment");
}

export function validateOllamaUrl(raw: string): OllamaEndpoint {
  if (!raw) fail("empty");
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control-byte rejection is normative.
  if (/[\u0000-\u001f\u007f]/.test(raw)) fail("control_character");
  if (raw !== raw.trim()) fail("surrounding_whitespace");
  rejectNonPrintableAscii(raw);
  if (raw.includes("?") || raw.includes("#")) fail("query_or_fragment");
  const match = raw.match(/^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/?#]*)(\/[^?#]*)?$/);
  if (!match) fail("syntax");
  const protocol = `${match[1]!.toLowerCase()}:` as "http:" | "https:";
  if (protocol !== "http:" && protocol !== "https:") fail("scheme");
  const authority = match[2]!;
  if (!authority) fail("syntax");
  if (authority.includes("@")) fail("credentials");
  if (authority.includes("%")) fail("authority_encoding");
  const rawPath = match[3] ?? "";
  preparseRawPath(rawPath);

  let rawHost: string;
  let rawPort: string | undefined;
  let ipv6 = false;
  if (authority.startsWith("[")) {
    const bracketed = authority.match(/^\[([^\]]+)\](?::([^:]+))?$/);
    if (!bracketed) fail("syntax");
    rawHost = bracketed[1]!;
    rawPort = bracketed[2];
    ipv6 = true;
  } else {
    if ((authority.match(/:/g) ?? []).length > 1) fail("syntax");
    const colon = authority.lastIndexOf(":");
    rawHost = colon >= 0 ? authority.slice(0, colon) : authority;
    rawPort = colon >= 0 ? authority.slice(colon + 1) : undefined;
  }
  if (!rawHost || rawPort === "") fail(rawPort === "" ? "port" : "syntax");

  const ascii = rawHost.toLowerCase();
  if (ipv6 && ascii.endsWith(".")) fail("syntax");
  const hadTrailingDot = !ipv6 && ascii.endsWith(".");
  const hostname = hadTrailingDot ? ascii.slice(0, -1) : ascii;
  if (!hostname || hostname.endsWith(".")) fail("syntax");
  if (hadTrailingDot && hostname !== "localhost") fail("syntax");

  let connectHost: string;
  let serverName: string | undefined;
  if (ipv6) {
    if (isIP(hostname) === 4) fail("syntax");
    if (hostname !== "::1" || isIP(hostname) !== 6) fail("non_loopback_host");
    connectHost = "::1";
  } else if (hostname === "localhost") {
    connectHost = "127.0.0.1";
    serverName = "localhost";
  } else {
    if (numericLooking(hostname) && !/^[0-9.]+$/.test(hostname)) fail("ambiguous_numeric_host");
    connectHost = canonicalIpv4(hostname);
  }

  const port = parsePort(rawPort, protocol);
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    fail("syntax");
  }
  const basePath = parsed.pathname.replace(/\/+$/, "");
  const hostHeader = authority;
  return {
    protocol,
    hostname,
    connectHost,
    port,
    hostHeader,
    basePath,
    serverName,
    canLaunchServer: protocol === "http:" && basePath === "",
    bindAuthority: `${ipv6 ? `[${connectHost}]` : connectHost}:${port}`,
  };
}

export function ollamaApiUrl(endpoint: OllamaEndpoint, apiPath: `/${string}`): string {
  const host = endpoint.hostname === "::1" ? "[::1]" : endpoint.hostname;
  const defaultPort =
    (endpoint.protocol === "http:" && endpoint.port === 80) ||
    (endpoint.protocol === "https:" && endpoint.port === 443);
  const port = defaultPort ? "" : `:${endpoint.port}`;
  return `${endpoint.protocol}//${host}${port}${endpoint.basePath}${apiPath}`;
}

export function ollamaPreflight(raw: string):
  | { ok: true; endpoint: OllamaEndpoint }
  | {
      ok: false;
      exitCode: 40;
      rule: OllamaUrlRule;
      error: string;
      fix: string;
    } {
  try {
    return { ok: true, endpoint: validateOllamaUrl(raw) };
  } catch (error) {
    const rule = error instanceof OllamaUrlError ? error.rule : "syntax";
    return {
      ok: false,
      exitCode: 40,
      rule,
      error: `ERROR: OLLAMA_URL is invalid for local Ollama (${rule}).`,
      fix:
        "FIX: set OLLAMA_URL=http://localhost:11434 " +
        "(or another canonical loopback literal), then retry.",
    };
  }
}
