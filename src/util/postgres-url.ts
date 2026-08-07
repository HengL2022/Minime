const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

export const GUARDED_MINIME_DATABASE = /^(?:minime|minime_test(?:_[a-z0-9_]+)?|minime_eval_lme1)$/;
export const GUARDED_RECOVERY_SOURCE_DATABASE = /^(?:minime|minime_test(?:_[a-z0-9_]+)?)$/;

export interface LocalPostgresUrl {
  readonly url: URL;
  readonly hostname: string;
  readonly port: string;
  readonly database: string;
  readonly serverIdentity: string;
}

function invalid(): never {
  throw new Error("database_endpoint_invalid");
}

function decode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return invalid();
  }
}

function hasControl(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function cleanDecoded(value: string): string {
  // Decoded controls can be reinterpreted by downstream URI/libpq parsers.
  if (hasControl(value)) invalid();
  return value;
}

function normalizedHostname(url: URL): string {
  const hostname = url.hostname.toLowerCase();
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

/** Parse the small local PostgreSQL URI surface Minime supports without echoing the URI. */
export function parseLocalPostgresUrl(
  raw: string,
  expectedDatabase: string | RegExp = GUARDED_MINIME_DATABASE,
): LocalPostgresUrl {
  if (!raw || raw !== raw.trim() || hasControl(raw) || raw.includes("?") || raw.includes("#")) {
    return invalid();
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return invalid();
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") invalid();

  const hostname = normalizedHostname(url);
  if (!LOOPBACK_HOSTS.has(hostname)) invalid();
  const username = cleanDecoded(decode(url.username));
  cleanDecoded(decode(url.password));
  const database = cleanDecoded(decode(url.pathname.replace(/^\//, "")));
  if (!username || !database || url.pathname.slice(1).includes("/")) invalid();
  if (
    typeof expectedDatabase === "string"
      ? database !== expectedDatabase
      : !expectedDatabase.test(database)
  ) {
    invalid();
  }

  const port = url.port || "5432";
  return {
    url,
    hostname,
    port,
    database,
    serverIdentity: `${hostname}:${port}`,
  };
}

export function samePostgresServer(a: LocalPostgresUrl, b: LocalPostgresUrl): boolean {
  return a.hostname === b.hostname && a.port === b.port;
}

/** Validate the owner/app pair at config load, including guarded scratch test endpoints. */
export function validateMinimeDatabasePair(
  ownerRaw: string,
  appRaw: string,
): { readonly owner: LocalPostgresUrl; readonly app: LocalPostgresUrl } {
  try {
    const owner = parseLocalPostgresUrl(ownerRaw);
    const app = parseLocalPostgresUrl(appRaw);
    if (!samePostgresServer(owner, app) || owner.database !== app.database) invalid();
    return { owner, app };
  } catch {
    return invalid();
  }
}

/** Preserve the already-validated database host/port/path while replacing only credentials. */
export function derivePostgresCredentials(
  raw: string,
  username: string,
  password: string,
  expectedDatabase: string | RegExp = GUARDED_MINIME_DATABASE,
): string {
  const parsed = parseLocalPostgresUrl(raw, expectedDatabase);
  if (!username || !password) invalid();
  cleanDecoded(username);
  cleanDecoded(password);
  const result = new URL(parsed.url.toString());
  result.username = username;
  result.password = password;
  return result.toString();
}
