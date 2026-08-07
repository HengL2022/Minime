import {
  GUARDED_RECOVERY_SOURCE_DATABASE,
  type LocalPostgresUrl,
  parseLocalPostgresUrl,
  samePostgresServer,
} from "../util/postgres-url";

export interface RecoveryEndpoints {
  readonly source: string;
  readonly admin: string;
  readonly drill: string;
  readonly live: string;
  readonly restore: string;
}

function parseEndpoint(raw: string, expectedDatabase: string | RegExp): LocalPostgresUrl {
  try {
    return parseLocalPostgresUrl(raw, expectedDatabase);
  } catch {
    throw new Error("recovery_endpoint_invalid");
  }
}

function validateEndpoints(endpoints: RecoveryEndpoints, sourceDatabase: string | RegExp): void {
  const parsed = [
    parseEndpoint(endpoints.source, sourceDatabase),
    parseEndpoint(endpoints.admin, "postgres"),
    parseEndpoint(endpoints.drill, "minime_drill"),
    parseEndpoint(endpoints.live, "minime"),
    parseEndpoint(endpoints.restore, "minime_restore"),
  ];
  const source = parsed[0]!;
  if (parsed.some((endpoint) => !samePostgresServer(source, endpoint))) {
    throw new Error("recovery_endpoint_invalid");
  }
}

/** Bind drill/PITR connections to one cluster while permitting a guarded test source. */
export function validateRecoveryEndpoints(endpoints: RecoveryEndpoints): void {
  validateEndpoints(endpoints, GUARDED_RECOVERY_SOURCE_DATABASE);
}

/** Promotion must take its pre-image from the exact live database it will replace. */
export function validatePromotionEndpoints(endpoints: RecoveryEndpoints): void {
  validateEndpoints(endpoints, "minime");
}
