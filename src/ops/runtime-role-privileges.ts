/** Reviewable application-role allow-list.  Migration 021 is the source of enforcement. */
export type TablePrivilege = "SELECT" | "INSERT" | "UPDATE" | "DELETE";

export const RUNTIME_ROLE_TABLE_PRIVILEGES = {
  schema_migrations: ["SELECT"],
  values_items: ["SELECT", "INSERT"],
  goals: ["SELECT", "INSERT", "UPDATE"],
  principles: ["SELECT", "INSERT"],
  commitments: ["SELECT", "INSERT", "UPDATE"],
  journal_entries: ["SELECT", "INSERT"],
  person_aliases: ["SELECT", "INSERT"],
  interactions: ["SELECT", "INSERT"],
  calendar_events: ["SELECT", "INSERT", "UPDATE", "DELETE"],
  email_meta: ["SELECT", "INSERT"],
  org_aliases: ["SELECT", "INSERT"],
  decision_transcripts: ["SELECT", "INSERT"],
  decision_branches: ["SELECT", "INSERT"],
  edge_validations: ["SELECT", "INSERT"],
  tasks: ["SELECT", "INSERT", "UPDATE"],
  decisions: ["SELECT", "INSERT", "UPDATE"],
  people: ["SELECT", "INSERT", "UPDATE"],
  pages: ["SELECT", "INSERT", "UPDATE"],
  metric_values: ["SELECT"],
  metric_cache_state: ["SELECT"],
  review_queue: ["SELECT", "INSERT", "UPDATE"],
  inbox_items: ["SELECT", "INSERT", "UPDATE"],
  orgs: ["SELECT", "INSERT", "UPDATE"],
  person_dates: ["SELECT", "INSERT", "UPDATE"],
  events: ["SELECT", "INSERT"],
  chunks: ["SELECT", "INSERT", "UPDATE", "DELETE"],
  edges: ["SELECT", "INSERT", "UPDATE", "DELETE"],
  transactions: ["INSERT"],
  health_samples: ["INSERT"],
  metric_defs: ["SELECT"],
} as const satisfies Record<string, readonly TablePrivilege[]>;

export const RUNTIME_ROLE_TABLES = Object.freeze(Object.keys(RUNTIME_ROLE_TABLE_PRIVILEGES));
export const RUNTIME_ROLE_APPLICATION_FUNCTIONS = Object.freeze([
  "app_allowed_tier()",
  "app_request_tier2_unlock(smallint)",
  "metric_agg(text,date,date,text)",
  "timeline_locked_count(text,date,date,text)",
  "suppressed_candidate_count(text,vector,int,text[])",
  "cjk_fold(text)",
  "entity_canonical_name(text,uuid)",
  "exact_active_org_exists(text)",
  "person_has_nonworking_relation(uuid)",
  "readable_source_tier(text,uuid)",
  "set_person_relation_if_null(uuid,text)",
  "touch_person_last_contact(uuid,timestamptz)",
  "resolve_or_promote_entity(text,text,smallint,text,text,uuid)",
  "resolve_or_promote_extracted_person(text,smallint,text,text,uuid)",
  "resolve_or_promote_extracted_org(text,text,smallint,text,text,uuid)",
  "upsert_derived_alias(text,uuid,text,smallint,text,text,uuid)",
  "upsert_extracted_edge(text,uuid,text,text,uuid,text,uuid,real)",
] as const);
// No system/catalog functions are granted.  Keep this explicit so the manifest cannot drift
// from migration 021's deny-all posture.
export const RUNTIME_ROLE_SYSTEM_FUNCTIONS = Object.freeze([] as const);

export const RUNTIME_ROLE_PRIVILEGE_MANIFEST = Object.freeze({
  tables: RUNTIME_ROLE_TABLE_PRIVILEGES,
  database: Object.freeze({ app: ["CONNECT"] as const }),
  schema: Object.freeze({ app: ["USAGE"] as const }),
  applicationFunctions: RUNTIME_ROLE_APPLICATION_FUNCTIONS,
  systemFunctions: RUNTIME_ROLE_SYSTEM_FUNCTIONS,
});

export const RUNTIME_ROLE_PRIVILEGES = RUNTIME_ROLE_PRIVILEGE_MANIFEST;
export type RuntimeRolePrivilegeManifest = typeof RUNTIME_ROLE_PRIVILEGE_MANIFEST;
