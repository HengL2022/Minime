import { randomBytes } from "node:crypto";
import postgres from "postgres";

const PASSWORD_RE = /^[A-Za-z0-9_-]{24,128}$/;
const ROLE_RE = /^minime_test_app_[a-z0-9_]+$/;
const DATABASE_RE = /^minime_test_[a-z0-9_]+$/;
const FALLBACK_TEST_APP_PASSWORD = "minime_test_app_password_stable_20260805";
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export interface TestAppPasswordOptions {
  readonly env?: NodeJS.ProcessEnv;
  /** Retained for source compatibility; ignored by test helpers. */
  readonly allowRepoDotenv?: boolean;
}

export interface TestAppRoleLease {
  readonly roleName: string;
  readonly password: string;
  readonly databaseName: string;
  readonly databaseUrl: string;
}

function validPassword(value: string | undefined): value is string {
  return value !== undefined && PASSWORD_RE.test(value);
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function parseTarget(raw: string): { url: URL; databaseName: string } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("test_app_role_endpoint_invalid");
  }
  if (
    (url.protocol !== "postgres:" && url.protocol !== "postgresql:") ||
    !LOOPBACK_HOSTS.has(url.hostname.toLowerCase())
  ) {
    throw new Error("test_app_role_endpoint_invalid");
  }
  const databaseName = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (!DATABASE_RE.test(databaseName)) throw new Error("test_app_role_database_invalid");
  return { url, databaseName };
}

function ownerDatabaseUrl(): string {
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error("test_app_role_owner_url_missing");
  return raw;
}

function ownerTargetUrl(databaseName: string): string {
  const url = new URL(ownerDatabaseUrl());
  url.pathname = `/${databaseName}`;
  return url.toString();
}

function ownerAdminUrl(): string {
  const url = new URL(ownerDatabaseUrl());
  url.pathname = "/postgres";
  return url.toString();
}

/** Resolve only explicit process credentials. */
export function resolveTestAppPassword(options: TestAppPasswordOptions = {}): string {
  const env = options.env ?? process.env;
  const endpoint = env.MINIME_APP_DATABASE_URL?.trim();
  const configured = env.MINIME_APP_PASSWORD;
  if (configured !== undefined && !validPassword(configured)) {
    throw new Error("test_app_role_password_invalid");
  }
  if (endpoint) {
    let parsed: URL;
    try {
      parsed = new URL(endpoint);
    } catch {
      throw new Error("test_app_role_endpoint_invalid");
    }
    if (
      (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") ||
      !LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase())
    ) {
      throw new Error("test_app_role_endpoint_invalid");
    }
    if (parsed.username && !ROLE_RE.test(parsed.username) && parsed.username !== "minime_app") {
      throw new Error("test_app_role_endpoint_invalid");
    }
    if (parsed.password && !validPassword(parsed.password)) {
      throw new Error("test_app_role_password_invalid");
    }
    if (parsed.password && configured && parsed.password !== configured) {
      throw new Error("test_app_role_credentials_mismatch");
    }
    if (parsed.password) return parsed.password;
  }
  if (configured) return configured;
  return FALLBACK_TEST_APP_PASSWORD;
}

function createRoleName(): string {
  return `minime_test_app_${randomBytes(12).toString("hex")}`;
}

function createPassword(): string {
  return randomBytes(32).toString("base64url");
}

const SELECT_TABLES = [
  "schema_migrations",
  "values_items",
  "goals",
  "principles",
  "commitments",
  "journal_entries",
  "person_aliases",
  "interactions",
  "calendar_events",
  "email_meta",
  "org_aliases",
  "decision_transcripts",
  "decision_branches",
  "edge_validations",
  "tasks",
  "decisions",
  "people",
  "pages",
  "metric_values",
  "metric_cache_state",
  "review_queue",
  "inbox_items",
  "orgs",
  "person_dates",
  "events",
  "chunks",
  "edges",
  "metric_defs",
] as const;
const INSERT_TABLES = [
  "values_items",
  "goals",
  "principles",
  "commitments",
  "journal_entries",
  "person_aliases",
  "interactions",
  "calendar_events",
  "email_meta",
  "org_aliases",
  "decision_transcripts",
  "decision_branches",
  "edge_validations",
  "tasks",
  "decisions",
  "people",
  "pages",
  "review_queue",
  "inbox_items",
  "orgs",
  "person_dates",
  "events",
  "chunks",
  "edges",
  "transactions",
  "health_samples",
] as const;
const UPDATE_TABLES = [
  "tasks",
  "decisions",
  "people",
  "pages",
  "review_queue",
  "inbox_items",
  "orgs",
  "person_dates",
  "chunks",
  "edges",
  "decision_branches",
  "calendar_events",
] as const;
const TIER_TABLES = [
  "journal_entries",
  "interactions",
  "email_meta",
  "pages",
  "chunks",
  "tasks",
  "goals",
  "values_items",
  "principles",
  "decisions",
  "commitments",
  "people",
  "calendar_events",
  "inbox_items",
  "edges",
  "orgs",
  "person_dates",
  "decision_transcripts",
  "decision_branches",
] as const;

function names(values: readonly string[]): string {
  return values.map(quoteIdentifier).join(", ");
}

async function configureBoundary(target: postgres.Sql, roleName: string): Promise<void> {
  const role = quoteIdentifier(roleName);
  await target.unsafe(`grant select on ${names(SELECT_TABLES)} to ${role}`);
  await target.unsafe(`grant insert on ${names(INSERT_TABLES)} to ${role}`);
  await target.unsafe(`grant update on ${names(UPDATE_TABLES)} to ${role}`);
  await target.unsafe(`grant delete on chunks, edges to ${role}`);
  await target.unsafe(`grant usage, select on sequence events_id_seq to ${role}`);
  for (const fn of [
    "app_allowed_tier()",
    "app_request_tier2_unlock(smallint)",
    "metric_agg(text, date, date, text)",
    "timeline_locked_count(text, date, date, text)",
    "cjk_fold(text)",
    "exact_active_org_exists(text)",
    "person_has_nonworking_relation(uuid)",
    "readable_source_tier(text, uuid)",
    "set_person_relation_if_null(uuid, text)",
    "touch_person_last_contact(uuid, timestamptz)",
    "resolve_or_promote_entity(text, text, smallint, text, text, uuid)",
    "resolve_or_promote_extracted_person(text, smallint, text, text, uuid)",
    "resolve_or_promote_extracted_org(text, text, smallint, text, text, uuid)",
    "upsert_derived_alias(text, uuid, text, smallint, text, text, uuid)",
    "upsert_extracted_edge(text, uuid, text, text, uuid, text, uuid, real)",
  ]) {
    await target.unsafe(`grant execute on function ${fn} to ${role}`);
  }
  await target.unsafe(`revoke create on schema public from ${role}`);

  const suffix = roleName.slice("minime_test_app_".length);
  for (const table of TIER_TABLES) {
    const quoted = quoteIdentifier(table);
    await target.unsafe(
      `create policy ${quoteIdentifier(`test_${suffix}_select`)} on ${quoted} for select to ${role} using (tier >= 1 and tier <= app_allowed_tier())`,
    );
    if (INSERT_TABLES.includes(table as (typeof INSERT_TABLES)[number])) {
      await target.unsafe(
        `create policy ${quoteIdentifier(`test_${suffix}_insert`)} on ${quoted} for insert to ${role} with check (true)`,
      );
    }
    if (UPDATE_TABLES.includes(table as (typeof UPDATE_TABLES)[number])) {
      await target.unsafe(
        `create policy ${quoteIdentifier(`test_${suffix}_update`)} on ${quoted} for update to ${role} using (tier >= 1 and tier <= app_allowed_tier())`,
      );
    }
    if (table === "chunks" || table === "edges") {
      await target.unsafe(
        `create policy ${quoteIdentifier(`test_${suffix}_delete`)} on ${quoted} for delete to ${role} using (tier >= 1 and tier <= app_allowed_tier())`,
      );
    }
  }
}

/** Mint a fresh login role and apply the production app boundary to one guarded scratch DB. */
export async function mintTestAppRole(
  databaseUrl: string,
  options: { readonly roleName?: string; readonly password?: string } = {},
): Promise<TestAppRoleLease> {
  const { url, databaseName } = parseTarget(databaseUrl);
  const roleName = options.roleName ?? createRoleName();
  const password = options.password ?? createPassword();
  if (!ROLE_RE.test(roleName)) throw new Error("test_app_role_name_invalid");
  if (!validPassword(password)) throw new Error("test_app_role_password_invalid");
  const owner = postgres(ownerDatabaseUrl(), { max: 1, onnotice: () => {} });
  const target = postgres(databaseUrl, { max: 1, onnotice: () => {} });
  let created = false;
  const child = new URL(url.toString());
  child.username = roleName;
  child.password = password;
  const lease = Object.freeze({
    roleName,
    password,
    databaseName,
    databaseUrl: child.toString(),
  });
  try {
    await owner.unsafe(
      `create role ${quoteIdentifier(roleName)} login password ${quoteLiteral(password)} nosuperuser nocreatedb nocreaterole nobypassrls noinherit noreplication`,
    );
    created = true;
    await configureBoundary(target, roleName);
    await owner.unsafe(
      `grant connect on database ${quoteIdentifier(databaseName)} to ${quoteIdentifier(roleName)}`,
    );
    return lease;
  } catch (error) {
    if (created) {
      try {
        await dropTestAppRole(lease);
      } catch {
        throw new Error("test_database_cleanup_failed");
      }
    }
    throw error instanceof Error ? error : new Error("test_app_role_provision_failed");
  } finally {
    await target.end({ timeout: 2 }).catch(() => {});
    await owner.end({ timeout: 2 }).catch(() => {});
  }
}

function quoteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export async function disableTestAppRole(lease: TestAppRoleLease): Promise<void> {
  if (!ROLE_RE.test(lease.roleName)) throw new Error("test_app_role_name_invalid");
  const owner = postgres(ownerDatabaseUrl(), { max: 1, onnotice: () => {} });
  try {
    await owner.unsafe(`alter role ${quoteIdentifier(lease.roleName)} nologin`);
  } finally {
    await owner.end({ timeout: 2 }).catch(() => {});
  }
}

/** Drop a role only after the wrapper has closed child pools and removed its database. */
export async function dropTestAppRole(lease: TestAppRoleLease): Promise<void> {
  if (!ROLE_RE.test(lease.roleName)) throw new Error("test_app_role_name_invalid");
  const target = postgres(ownerTargetUrl(lease.databaseName), { max: 1, onnotice: () => {} });
  try {
    try {
      const policies = await target<{ tablename: string; policyname: string }[]>`
        select tablename, policyname from pg_policies
        where ${lease.roleName}::name = any(roles)`;
      for (const policy of policies) {
        await target.unsafe(
          `drop policy if exists ${quoteIdentifier(policy.policyname)} on public.${quoteIdentifier(policy.tablename)}`,
        );
      }
      const role = quoteIdentifier(lease.roleName);
      await target.unsafe(`revoke all privileges on all tables in schema public from ${role}`);
      await target.unsafe(`revoke all privileges on all sequences in schema public from ${role}`);
      await target.unsafe(`revoke all privileges on all functions in schema public from ${role}`);
    } catch {
      // The wrapper drops the database before dropping its role; an absent target is expected.
    }
  } finally {
    await target.end({ timeout: 2 }).catch(() => {});
  }
  const owner = postgres(ownerAdminUrl(), { max: 1, onnotice: () => {} });
  try {
    await owner
      .unsafe(
        `revoke connect, temporary on database ${quoteIdentifier(lease.databaseName)} from ${quoteIdentifier(lease.roleName)}`,
      )
      .catch(() => {});
    await owner.unsafe(`drop role if exists ${quoteIdentifier(lease.roleName)}`);
  } finally {
    await owner.end({ timeout: 2 }).catch(() => {});
  }
}
