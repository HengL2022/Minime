const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
const GUARDED_SOURCE_DATABASE = /^(?:minime|minime_test(?:_[a-z0-9_]+)?)$/;

export interface RecoveryEndpoints {
  readonly source: string;
  readonly admin: string;
  readonly drill: string;
  readonly live: string;
  readonly restore: string;
}

function parseEndpoint(raw: string, expectedDatabase: string | RegExp): URL {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: reject URL normalization controls.
  const hasControl = /[\u0000-\u001f\u007f]/.test(raw);
  if (raw !== raw.trim() || hasControl || raw.includes("?") || raw.includes("#")) {
    throw new Error("recovery_endpoint_invalid");
  }
  let endpoint: URL;
  let database: string;
  try {
    endpoint = new URL(raw);
    database = decodeURIComponent(endpoint.pathname.replace(/^\//, ""));
  } catch {
    throw new Error("recovery_endpoint_invalid");
  }
  if (
    (endpoint.protocol !== "postgres:" && endpoint.protocol !== "postgresql:") ||
    !LOOPBACK_HOSTS.has(endpoint.hostname.toLowerCase()) ||
    !endpoint.username ||
    !database ||
    (typeof expectedDatabase === "string"
      ? database !== expectedDatabase
      : !expectedDatabase.test(database))
  ) {
    throw new Error("recovery_endpoint_invalid");
  }
  return endpoint;
}

function effectivePort(endpoint: URL): string {
  return endpoint.port || "5432";
}

/** Bind every recovery connection to the local Minime cluster and its fixed database role. */
export function validateRecoveryEndpoints(endpoints: RecoveryEndpoints): void {
  const parsed = [
    parseEndpoint(endpoints.source, GUARDED_SOURCE_DATABASE),
    parseEndpoint(endpoints.admin, "postgres"),
    parseEndpoint(endpoints.drill, "minime_drill"),
    parseEndpoint(endpoints.live, "minime"),
    parseEndpoint(endpoints.restore, "minime_restore"),
  ];
  const port = effectivePort(parsed[0]!);
  if (parsed.some((endpoint) => effectivePort(endpoint) !== port)) {
    throw new Error("recovery_endpoint_invalid");
  }
}
