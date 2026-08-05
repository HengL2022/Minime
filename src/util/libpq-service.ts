import {
  constants,
  chmodSync,
  closeSync,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { lstat, open, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

export const LIBPQ_SERVICE_NAME = "minime_ephemeral" as const;

export type LibpqServiceRule =
  | "empty"
  | "scheme"
  | "syntax"
  | "percent_encoding"
  | "control_character"
  | "nested_service"
  | "edge_whitespace"
  | "line_too_long"
  | "filesystem";

export class LibpqServiceError extends Error {
  readonly rule: LibpqServiceRule;

  constructor(rule: LibpqServiceRule) {
    super(`libpq service ${rule}`);
    this.name = "LibpqServiceError";
    this.rule = rule;
  }
}

function fail(rule: LibpqServiceRule): never {
  throw new LibpqServiceError(rule);
}

function decode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    fail("percent_encoding");
  }
}

function validateValue(value: string): string {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) fail("control_character");
  }
  if (/^[\t ]|[\t ]$/.test(value)) fail("edge_whitespace");
  return value;
}

function decodeValue(value: string): string {
  return validateValue(decode(value));
}

function parseAuthority(authority: string): ReadonlyMap<string, string> {
  const params = new Map<string, string>();
  if (!authority) return params;
  const at = authority.lastIndexOf("@");
  let hostPort = authority;
  if (at >= 0) {
    const userInfo = authority.slice(0, at);
    hostPort = authority.slice(at + 1);
    const colon = userInfo.indexOf(":");
    if (colon < 0) params.set("user", decodeValue(userInfo));
    else {
      params.set("user", decodeValue(userInfo.slice(0, colon)));
      params.set("password", decodeValue(userInfo.slice(colon + 1)));
    }
  }
  if (!hostPort) fail("syntax");

  const hosts: string[] = [];
  const ports: string[] = [];
  for (const component of hostPort.split(",")) {
    if (!component) fail("syntax");
    let hostRaw = component;
    let portRaw: string | undefined;
    if (component.startsWith("[")) {
      const close = component.indexOf("]");
      if (close <= 1) fail("syntax");
      hostRaw = component.slice(1, close);
      const tail = component.slice(close + 1);
      if (tail) {
        if (!tail.startsWith(":") || tail.length === 1) fail("syntax");
        portRaw = tail.slice(1);
      }
    } else {
      const colon = component.lastIndexOf(":");
      if (colon >= 0 && component.indexOf(":") === colon) {
        hostRaw = component.slice(0, colon);
        portRaw = component.slice(colon + 1);
        if (!portRaw) fail("syntax");
      } else if (component.includes(":")) {
        // Unbracketed IPv6 is accepted as a host without treating its colons as a port.
        hostRaw = component;
      }
    }
    const host = decodeValue(hostRaw);
    if (!host) fail("syntax");
    if (portRaw !== undefined && !/^\d+$/.test(decode(portRaw))) fail("syntax");
    hosts.push(host);
    if (portRaw !== undefined) ports.push(decodeValue(portRaw));
  }
  params.set("host", hosts.join(","));
  if (ports.length) params.set("port", ports.join(","));
  return params;
}

export function parsePostgresUri(raw: string): ReadonlyMap<string, string> {
  if (!raw) fail("empty");
  if (!/^(?:postgres|postgresql):\/\//.test(raw)) fail("scheme");
  // Keep URI tokenization independent of WHATWG hostname canonicalization.  In particular,
  // this preserves comma-separated hosts and bracketed IPv6 exactly as libpq expects.
  const body = raw.slice(raw.indexOf("://") + 3);
  const queryAt = body.indexOf("?");
  const fragmentAt = body.indexOf("#");
  if (fragmentAt >= 0) fail("syntax");
  const authorityEndCandidates = [queryAt < 0 ? body.length : queryAt];
  const slashAt = body.indexOf("/");
  if (slashAt >= 0 && (queryAt < 0 || slashAt < queryAt)) authorityEndCandidates.push(slashAt);
  const authorityEnd = Math.min(...authorityEndCandidates);
  const authority = body.slice(0, authorityEnd);
  const params = new Map(parseAuthority(authority));

  const pathEnd = queryAt < 0 ? body.length : queryAt;
  if (slashAt >= 0 && slashAt < pathEnd) {
    const path = body.slice(slashAt + 1, pathEnd);
    if (path) params.set("dbname", decodeValue(path));
  }
  if (!authority && !params.has("dbname") && queryAt < 0) fail("syntax");
  if (queryAt >= 0) {
    for (const pair of body.slice(queryAt + 1).split("&")) {
      if (!pair) continue;
      const eq = pair.indexOf("=");
      const keyRaw = eq < 0 ? pair : pair.slice(0, eq);
      const valueRaw = eq < 0 ? "" : pair.slice(eq + 1);
      const key = decodeValue(keyRaw).toLowerCase();
      if (!/^[a-z_][a-z0-9_]*$/.test(key)) fail("syntax");
      if (key === "service" || key === "servicefile") fail("nested_service");
      const value = decodeValue(valueRaw);
      if (key === "ssl" && value.toLowerCase() === "true") params.set("sslmode", "require");
      else params.set(key, value);
    }
  }
  return params;
}

const STRUCTURAL_KEYS = ["host", "port", "user", "password", "dbname"] as const;

export function renderLibpqService(parameters: ReadonlyMap<string, string>): string {
  const normalized = new Map<string, string>();
  for (const [rawKey, rawValue] of parameters) {
    const key = rawKey.toLowerCase();
    if (!/^[a-z_][a-z0-9_]*$/.test(key)) fail("syntax");
    if (key === "service" || key === "servicefile") fail("nested_service");
    let value = validateValue(String(rawValue));
    if (key === "ssl" && value.toLowerCase() === "true") {
      value = "require";
    }
    const normalizedKey = key === "ssl" && value === "require" ? "sslmode" : key;
    const line = `${normalizedKey}=${value}\n`;
    if (Buffer.byteLength(line, "utf8") > 1022) fail("line_too_long");
    normalized.set(normalizedKey, value);
  }
  const keys = [
    ...STRUCTURAL_KEYS.filter((key) => normalized.has(key)),
    ...[...normalized.keys()]
      .filter((key) => !(STRUCTURAL_KEYS as readonly string[]).includes(key))
      .sort(),
  ];
  let out = `[${LIBPQ_SERVICE_NAME}]\n`;
  for (const key of keys) out += `${key}=${normalized.get(key)}\n`;
  return out;
}

async function removeOwnedDirectory(directory: string): Promise<boolean> {
  const absent = async (): Promise<boolean> => {
    try {
      serviceAbsenceProbeForTest?.();
    } catch {
      return false;
    }
    try {
      await lstat(directory);
      return false;
    } catch (error: unknown) {
      return (error as NodeJS.ErrnoException).code === "ENOENT";
    }
  };
  try {
    const entry = await lstat(directory);
    if (!entry.isDirectory() || entry.isSymbolicLink()) return false;
    if ((await realpath(directory)) !== directory) return false;
    await rm(directory, { recursive: true, force: true });
    return await absent();
  } catch {
    return await absent();
  }
}

function removeOwnedDirectorySync(directory: string): boolean {
  try {
    const entry = lstatSync(directory);
    if (!entry.isDirectory() || entry.isSymbolicLink()) return false;
    if (realpathSync(directory) !== directory) return false;
    rmSync(directory, { recursive: true, force: true });
    return !lstatSync(directory, { throwIfNoEntry: false });
  } catch {
    return !lstatSync(directory, { throwIfNoEntry: false });
  }
}

const cleanupEntries = new Map<string, EphemeralCleanup>();
let signalHandlersInstalled = false;
let afterLeaseRegisterForTest: ((directory: string) => void) | undefined;
let afterServiceOpenForTest: (() => void) | undefined;
let serviceAbsenceProbeForTest: (() => void) | undefined;
let signalFailureReported = false;

function onSignal(signal: NodeJS.Signals): void {
  const entries = [...cleanupEntries.entries()].reverse();
  for (const [path, cleanup] of entries) {
    let cleaned = false;
    try {
      cleaned = cleanup();
    } catch {
      cleaned = false;
    }
    if (cleaned) cleanupEntries.delete(path);
    else if (!signalFailureReported) {
      signalFailureReported = true;
      process.stderr.write("ephemeral cleanup failed (signal)\n");
    }
  }
  process.removeListener("SIGHUP", onSignal as (...args: unknown[]) => void);
  process.removeListener("SIGINT", onSignal as (...args: unknown[]) => void);
  process.removeListener("SIGTERM", onSignal as (...args: unknown[]) => void);
  signalHandlersInstalled = false;
  process.kill(process.pid, signal);
}

export type EphemeralCleanup = () => boolean;

export function registerEphemeralCleanup(
  path: string,
  cleanup: EphemeralCleanup = () => true,
): () => void {
  if (!isAbsolute(path)) throw new LibpqServiceError("filesystem");
  cleanupEntries.set(path, cleanup);
  if (!signalHandlersInstalled) {
    signalHandlersInstalled = true;
    process.on("SIGHUP", onSignal);
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
  }
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    cleanupEntries.delete(path);
    if (cleanupEntries.size === 0 && signalHandlersInstalled) {
      process.removeListener("SIGHUP", onSignal as (...args: unknown[]) => void);
      process.removeListener("SIGINT", onSignal as (...args: unknown[]) => void);
      process.removeListener("SIGTERM", onSignal as (...args: unknown[]) => void);
      signalHandlersInstalled = false;
    }
  };
}

export function __setAfterLeaseRegisterForTest(
  hook: ((directory: string) => void) | undefined,
): void {
  afterLeaseRegisterForTest = hook;
}

export function __setAfterServiceOpenForTest(hook: (() => void) | undefined): void {
  afterServiceOpenForTest = hook;
}

export function __setServiceAbsenceProbeForTest(hook: (() => void) | undefined): void {
  serviceAbsenceProbeForTest = hook;
}

export function __getEphemeralRegistrySizeForTest(): number {
  return cleanupEntries.size;
}

export function __getEphemeralRegistryPathsForTest(): string[] {
  return [...cleanupEntries.keys()];
}

export function __runEphemeralCleanupForTest(): void {
  for (const [path, cleanup] of [...cleanupEntries.entries()]) {
    if (cleanup()) cleanupEntries.delete(path);
  }
}

async function writeRenderedService(rendered: string, serviceFile: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let owned = false;
  try {
    handle = await open(serviceFile, "wx", 0o600);
    owned = true;
    afterServiceOpenForTest?.();
    await handle.writeFile(rendered, "utf8");
    await handle.sync();
    await handle.chmod(0o600);
    const info = await handle.stat();
    if ((info.mode & 0o777) !== 0o600) fail("filesystem");
  } catch (error) {
    try {
      await handle?.close();
    } catch {
      // fixed cleanup path
    }
    if (owned) await rm(serviceFile, { force: true }).catch(() => {});
    if (error instanceof LibpqServiceError) throw error;
    fail("filesystem");
  }
  await handle.close();
}

export async function writeLibpqServiceFile(raw: string, serviceFile: string): Promise<void> {
  if (raw.endsWith("\n") || raw.endsWith("\r")) fail("control_character");
  if (!isAbsolute(serviceFile)) fail("filesystem");
  const rendered = renderLibpqService(parsePostgresUri(raw));
  await writeRenderedService(rendered, serviceFile);
}

export interface LibpqServiceLease {
  readonly directory: string;
  readonly serviceFile: string;
  readonly serviceName: typeof LIBPQ_SERVICE_NAME;
  env(base?: NodeJS.ProcessEnv): Record<string, string>;
  dispose(): Promise<void>;
}

export async function createLibpqService(raw: string): Promise<LibpqServiceLease> {
  let directory: string;
  try {
    directory = realpathSync(mkdtempSync(join(tmpdir(), "minime-libpq-")));
  } catch {
    fail("filesystem");
  }
  let unregistered: (() => void) | undefined;
  try {
    unregistered = registerEphemeralCleanup(directory, () => removeOwnedDirectorySync(directory));
    afterLeaseRegisterForTest?.(directory);
    chmodSync(directory, 0o700);
    const info = statSync(directory);
    if ((info.mode & 0o777) !== 0o700 || (await realpath(directory)) !== directory)
      fail("filesystem");
    const serviceFile = join(directory, "pg_service.conf");
    await writeLibpqServiceFile(raw, serviceFile);
    let disposed = false;
    const lease: LibpqServiceLease = {
      directory,
      serviceFile,
      serviceName: LIBPQ_SERVICE_NAME,
      env(base = process.env) {
        return {
          ...base,
          PGSERVICE: LIBPQ_SERVICE_NAME,
          PGSERVICEFILE: serviceFile,
        };
      },
      async dispose() {
        if (disposed) return;
        const removed = await removeOwnedDirectory(directory);
        if (!removed) fail("filesystem");
        disposed = true;
        unregistered?.();
      },
    };
    return lease;
  } catch (error) {
    const removed = directory ? removeOwnedDirectorySync(directory) : true;
    if (removed) unregistered?.();
    if (error instanceof LibpqServiceError) throw error;
    fail("filesystem");
  }
}
