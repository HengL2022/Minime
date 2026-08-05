# Pre-W5 hardening design

**Date:** 2026-07-23

**Status:** Owner approved after Luna advisory PASS + Sol binding PASS

**Sequence:** Complete all five fixes before authoring or implementing W5

## Context

The July improvement program has completed W2, W3/M13, W1/M14, and W4/M15. The next
planned feature phase is W5 document ingestion, but the repository review found five
integrity and reliability gaps that should be closed first:

1. compiled-note archive files omit tier frontmatter;
2. a non-loopback `OLLAMA_URL` is still treated as local;
3. the default data directory depends on the process working directory;
4. a tool handler can mutate state before its audit row is durable;
5. the contradiction scan expects a chunk-edge shape the extractor does not write.

These fixes protect the existing product contract. They do not add owner-facing
features or change the W5–W9 roadmap.

## Goals

- Preserve compiled-note sensitivity and provenance across `brainSync()`.
- Make the Ollama provider local by construction.
- Make the default archive path independent of the MCP host's working directory.
- Guarantee that no tool handler begins without a durable append-only audit attempt.
- Make the contradiction scan operate on production extractor output.
- Keep each fix independently reviewable and revertible.
- Preserve all tier-0, tier-2, redaction, provenance, and SQL-containment invariants.

## Non-goals

- No remote or LAN Ollama mode. Remote inference uses the explicit cloud providers.
- No distributed transaction across PostgreSQL, files, and model calls.
- No automatic repair or deletion of graph entities or edges.
- No W5 parser registry, binary originals store, or image/VLM work.
- No redesign of the review queue, compiled-notes ranking boost, or access boost.
- No change to the accepted engineering-read audit gap recorded in `DECISIONS.md`.

## Execution structure

Use five sequential branches based on the preceding merged result:

1. `codex/hardening-ollama-loopback`
2. `codex/hardening-data-root`
3. `codex/hardening-note-tier`
4. `codex/hardening-audit-attempt`
5. `codex/hardening-contradiction-scan`

H2 closes the live egress bypass first. H3 then establishes the final archive/dump roots
before H1 adds recovery and repair files beneath that root. H4's transport refactor follows
the narrower configuration and archive fixes, and H5 remains last because it changes a
nightly model-work query without blocking the preceding safety fixes.

Each branch starts with a failing regression test, receives focused first-pass and
invariant review, and passes the project gates before merge. Parallel implementation is
deliberately avoided because these changes touch non-negotiable invariants and share
configuration, audit, and verification surfaces.

### Multi-agent role matrix

The hardening tranche uses fresh, role-scoped agents with binding review separation:

| Responsibility | Agent role | Model / effort | Authority |
|---|---|---|---|
| Binding orchestration plan and task graph | `planner_sol` | GPT-5.6 Sol / xhigh | Proposes task boundaries, dependencies, gates, and any deviation requiring owner approval |
| Implementation | `executor_luna` | GPT-5.6 Luna / xhigh | Implements one bounded task card test-first in its assigned worktree |
| First-pass review | `first_pass_reviewer_luna` | GPT-5.6 Luna / xhigh | Advisory spec-compliance and code-quality review |
| Critical/invariant review | `final_reviewer_sol` | GPT-5.6 Sol / xhigh | Binding PASS/BLOCK review before merge |
| Disputed Critical adjudication | `critical_adjudicator_sol` | GPT-5.6 Sol / xhigh | Independently closes a Critical finding raised by Luna |

The primary session coordinates filesystem and git mechanics against the binding Sol plan.
It does not waive a Sol BLOCK or approve a deviation. Only the owner can approve a deviation
from the build plan or this design. A fresh `final_reviewer_sol` must return binding PASS on
the detailed implementation plan before any executor starts. Executors never serve as their
own only reviewer. Findings return to the same executor when context is useful; otherwise a
fresh fix card is issued. The existing two-strike rule applies: two consecutive failed
review/gate cycles on one area stop the tranche for owner review rather than iterating
blindly.

## H1 — Tier-preserving compiled-note archives

### Problem

`compileNotes()` stores the correct inherited tier in `pages`, but writes a markdown
archive without frontmatter. `brainSync()` defaults frontmatter-free files to tier 1.
A later sync can therefore downgrade a tier-2 compiled note. The generated page hash is
also computed from the body while brain sync hashes the full archive bytes, causing
avoidable compile/sync churn once frontmatter is added.

### Design

Create one shared renderer/parser for a deterministic UTF-8 archive representation:

```text
---
title: "<JSON-escaped title>"
tier: <1|2>
---
<compiled body>
```

- The exact byte form is
  `---\ntitle: ${JSON.stringify(title)}\ntier: ${tier}\n---\n${bodyWithoutTerminalNewlines}\n`.
- Normalize CRLF/CR to LF in the compiled body and remove only terminal newline characters
  before the renderer adds exactly one; preserve every other body byte, including trailing
  spaces.
- `JSON.stringify()` supplies a YAML-compatible quoted scalar. The shared parser uses
  `JSON.parse()` for that scalar and retains a legacy plain/naively quoted-title fallback.
  Quotes, backslashes, colons, `---`, Unicode, and embedded newlines therefore round-trip.
- Hash the exact UTF-8 archive bytes and store that value as `pages.content_hash`.
- Store the normalized, frontmatter-free body in `pages.body_md` and chunks.
- Write those exact bytes to `data/brain/<derived note path>` by temporary sibling plus
  atomic rename.
- Make every newly created derived path collision-safe and identity-stable:
  `derived/notes/<kind>/<readable-slug>--<full-entity-uuid>.md`. The readable slug is
  cosmetic; the full UUID is the uniqueness boundary. Existing slug-only paths are
  grandfathered as described below.
- Keep `source='dream:notes'`, `created_by='system:dream'`, `derived_from`, and the
  inherited maximum source tier unchanged.

Replace the freshness early-return with an explicit reconciliation state machine:

1. Enumerate valid recovery records first, then every active `source='dream:notes'` page,
   every active page positively recognized as compiled by its UUID-suffixed derived path or
   canonical system marker plus Sources block, and every current entity candidate. Recovery
   records are first-class work items even when no page exists and the entity no longer meets
   the candidate threshold. Validate record
   version/schema, content hash, UUID identity, and a target path contained beneath the
   canonical brain root before use. Resolve the union to one work item per entity/page
   identity, preferring the durable recovery record, so one page is never reconciled or
   distilled twice in a run. Then load its page snapshot, archive bytes, and indexed-chunk
   state before deciding that the note is fresh.
2. When a distillation is required, write the normalized result and its source freshness
   marker to an atomic, local recovery record under `data/tmp/compiled-notes/` before
   changing the page, archive, or chunks. The record contains only the same local derived
   content and IDs that will be persisted; it never enters logs, events, or MCP output.
3. Reconcile the database page and canonical content hash from the page snapshot or recovery
   record, preserving the existing page ID. For a page positively identified by a recovery
   record, UUID-suffixed compiled path, or unambiguous system Sources mapping, explicitly
   restore `source='dream:notes'`, `created_by='system:dream'`, and the compiled
   `derived_from`; do not rely on the current `upsertPage()` behavior that leaves
   `brain-sync` provenance on an existing row.
4. Reconcile the archive bytes atomically.
5. Reindex only when chunks are absent or disagree on normalized body, parent ID, or tier.
6. Verify all three representations, then remove the recovery record. A stale recovery
   record whose target is already consistent is deleted without another model call.

A valid record is always converged once before reconsidering freshness. Source removal or a
drop below the candidate threshold does not discard an already-durable distillation. If the
current cluster contains mentions newer than the record's source-freshness marker, converge
the record first and then permit at most one new distillation for that newer snapshot. An
invalid/corrupt record is never used or deleted automatically; keep it private in place and
report only `invalid_recovery_record` plus its filename hash for owner inspection.

An already-fresh legacy page is itself the recovery source: missing/wrong frontmatter,
content hash, archive bytes, or chunks are repaired from `pages.body_md` without a
distillation call. A post-distillation failure in any page/hash/archive/chunk step resumes
from the recovery record on the next run without calling `completeJson()` again. Failure to
create the initial recovery record aborts before any target representation changes; because
no result became durable, a later run may distill again.

Legacy slug-only paths are associated but not automatically renamed:

- Map the UUIDs in the system-rendered Sources list back through their `mentions` edges.
- If they resolve to exactly one entity, retain that page ID/path as the entity's grandfathered
  note and reconcile it in place. No different entity may reuse or overwrite the path.
- If ownership is absent or ambiguous, keep the legacy page and archive, promote/reconcile
  them at tier 2, and report the content-free `legacy_path_ambiguous` status. Current entities
  receive distinct UUID-suffixed notes; ambiguous legacy material is never overwritten or
  deleted automatically.

Avoiding automatic legacy renames is deliberate: moving the database path and archive cannot
be atomic together, and a concurrent `brainSync()` could otherwise recreate the old path.

The authoritative repair tier is the maximum of the existing page tier, the current entity
mention cluster when present, and source chunks whose UUIDs appear in the system-rendered
`## Sources` list in `pages.body_md`. The archive is never authoritative. If a legacy compiled
page names a source UUID that cannot be resolved, or none of its source tiers can be resolved,
repair fails closed at tier 2. This works even though legacy `derived_from` lacks a parent type
and even when the page no longer meets the current candidate threshold. Neither lower archive
frontmatter nor a lower current source set may downgrade a compiled page.

`brainSync()` uses the same fail-closed rule for an existing page whose persisted source is
`dream:notes`: its effective tier is at least the current database page tier, and unresolved
compiled provenance forces tier 2. This prevents a stale/missing-tier archive from
re-downgrading the page or its chunks if sync interleaves between database and archive
reconciliation.

Archive absence is also non-authoritative for system compiled notes. The sync soft-delete
query must not mark `source='dream:notes'` pages deleted merely because their mirrored file is
missing; the compiler/recovery state owns their lifecycle and recreates the archive. Human and
ordinary `brain-sync` pages keep the existing delete-on-file-removal behavior.

### Failure behavior

- Reconciliation is idempotent and converges after process interruption between any steps.
- `compileNotes()` reports `created`, `updated`, `repaired`, `unchanged`, and `failed`
  separately; the dream summary includes the failure count.
- Errors expose a fixed operation code and opaque page ID or target hash only, never raw
  path, body text, title, model output, or tier-2 content. A failed item does not masquerade
  as `skipped`.
- No note is downgraded or deleted.
- No source text or tier-2 content is added to logs.

### Tests

- A mixed tier-1/tier-2 source set creates a tier-2 archive with canonical frontmatter.
- SHA-256 of the exact on-disk UTF-8 bytes equals `pages.content_hash`; the parsed normalized
  body equals `pages.body_md` and indexed chunk input before and after `brainSync()`.
- Running `brainSync()` afterward preserves page ID, tier, provenance, body, content hash,
  and indexed chunk tier.
- A second sync is a no-op.
- Legacy frontmatter-free, wrong-hash, and wrong-tier archives are repaired without a
  distillation call.
- A legacy `brainSync()` downgrade of both page and note chunks to tier 1 is restored to tier
  2 from the body source UUIDs, including when the note is no longer a current compile
  candidate.
- A missing referenced source promotes the legacy compiled page/archive/chunks to tier 2.
- Failure injection at page upsert, hash update, archive rename, and chunk replacement
  produces `failed`; the next run converges from the recovery record with zero additional
  `completeJson()` calls.
- After a page-upsert failure, remove enough live mentions to drop the entity below the
  candidate threshold; the orphaned recovery record is still discovered and converges with
  no additional model call.
- A fully consistent fresh note performs no write or reindex.
- Titles containing YAML punctuation, quotes, slashes, Unicode, and line breaks round-trip.
- Two entities whose names slugify identically produce distinct UUID-suffixed paths, pages,
  archives, provenance, and tiers. A uniquely owned legacy slug path remains associated
  in-place without changing page ID; an ambiguous legacy path remains retained at tier 2
  while current entities receive separate UUID paths.
- Active-page and current-candidate enumeration deduplicates to one reconciliation/model
  opportunity per identity.
- Pause reconciliation after the tier-2 page update but before archive replacement, run
  `brainSync()`, and prove page and note chunks remain tier 2; then resume and converge.
- Remove a tier-2 compiled archive, drop its source cluster below the candidate threshold, and
  run `brainSync()` before compile; the system page stays active/tier2 and compile recreates
  the archive from the page body without a model call.
- Import a canonical compiled archive through `brainSync()` before any page/recovery row
  exists, then reconcile it; page ID stays stable while source/creator/derived provenance is
  restored to the compiled-note values, and H5 excludes it as derived evidence.
- Inject a tier-2 name/path/body sentinel into model and reconciliation failures; assert
  `NoteResult`, dream summary, stderr, and events contain only the fixed code plus opaque
  ID/hash and none of the sentinel, raw title, path, body, or provider error.
- Existing compile freshness and new-mention tests remain green.

## H2 — Loopback-only Ollama

### Problem

The Ollama provider is always marked `isCloud: false`, but `OLLAMA_URL` accepts any host.
A remote URL therefore bypasses `CLOUD_MAX_TIER` and `egress:*` auditing.

### Design

Define one normative URL contract and a committed table-driven acceptance/rejection corpus.
Implement it twice where bootstrap constraints require: pure TypeScript
`validateOllamaUrl()` for runtime, and a dependency-free Bash validator for install/up
before Bun may exist. Both implementations must pass the identical corpus in CI; changing
one without parity fails the branch gate. The contract is:

- scheme must be `http:` or `https:`;
- username and password must be absent;
- the raw authority must contain no percent-encoding, zone ID, or ambiguous numeric host;
- hostname, after ASCII case and one trailing-dot normalization, must be:
  - `localhost`;
  - a canonical four-octet dotted-decimal IPv4 literal in `127.0.0.0/8`; or
  - bracketed IPv6 loopback `::1`;
- integer, hexadecimal, octal, shortened, and leading-zero IPv4 spellings are rejected even
  if the URL parser would normalize them to loopback;
- wildcard, LAN, public, DNS, and Unix-proxy hostnames are rejected;
- query strings and fragments are rejected;
- an explicit port and local base path remain allowed.

Do not perform DNS resolution. A hostname that merely resolves to loopback is not enough;
the guarantee must be visible from configuration alone.

Invoke the guard:

1. in the CLI preflight immediately after read-only environment/`.env` loading but before any
   command dispatch, database access, migration, watcher, filesystem mutation, or network work;
2. when constructing the Ollama provider, so commands that reach the provider without
   normal configuration initialization cannot bypass the guard;
3. from the environment verifier before it performs its Ollama request;
4. from `scripts/lib.sh` before `install.sh` or `up.sh` curls the configured server.

Every Minime CLI process rejects an invalid configured
`OLLAMA_URL`, including cloud-only and commands that do not presently call a model: a
configured value must never be a latent bypass. The installer flag `--no-ollama` skips model
pulls, reachability probes, and all Ollama network work, but it does not bypass pure validation
of an explicitly configured `OLLAMA_URL`; unset/default loopback configuration passes.
Installer validation occurs in the environment/config step before later Bun CLI calls.
Failure uses the established exit code 40 and emits the normal `FAIL`, `ERROR`, and
copy-pasteable `FIX` lines. `up.sh` fails before a request. Dry-run performs the same pure
validation with the dependency-free shell implementation, including on a fresh machine
without Bun. Reading environment variables and the repository `.env` to obtain configuration
is allowed; rejection precedes database access, migrations, watcher startup, network access,
and every filesystem mutation.

The TypeScript config loader remains side-effect-free apart from read-only `.env` loading.
At the first line of CLI `main()`, a non-throwing preflight validates the loaded URL, prints
fixed `ERROR:` / `FIX:` lines without echoing the value, and returns exit 40 before command
dispatch. Provider construction repeats the pure guard for direct library callers. This
avoids an uncaught ESM-import exception/exit 1 while still making every CLI command fail
closed.

For `install.sh` and `up.sh`, this is an immediate preflight before Bun installation,
dependency sync, Docker/Homebrew/system service actions, Postgres provisioning, or `.env`
creation. The shell preflight resolves only `OLLAMA_URL` using runtime-compatible precedence
(exported environment, then safely parsed repository `.env`, then the loopback default); it
does not `source` `.env` as shell code. Installer failure is reported against step 1 using the
existing `[N/9] FAIL` shape and exit 40, without adding a tenth step.

Ambient `OLLAMA_HOST` is never trusted. Installer/up subprocesses either discard it or replace
it with the validated loopback authority. Model pulls use the validated HTTP API (with the
same redirect refusal) rather than an unconstrained `ollama pull`; a locally launched
`ollama serve` receives an explicit loopback bind derived from the validated authority. A
base-path or HTTPS configuration is treated as an existing proxy and is never used to launch
a new plain server at a different path/origin; if unreachable, installation degrades under
the existing contract. Only a root-path HTTP URL can trigger `ollama serve`.

URL validation alone is insufficient because proxies and redirects can move a loopback request
off-box. Every TypeScript Ollama generation, embedding, pull, and verifier call uses one
dedicated direct-socket helper built on `node:http` / `node:https`, not ambient `fetch`.
The helper connects directly to the validated authority, never consults proxy environment,
never follows redirects, and treats every 3xx as failure before reading a response or making
another request. Shell calls put `curl -q` first to disable user/system curl configuration,
then use scoped `--noproxy '*' --proxy ''` (and remove upper- and lower-case `HTTP_PROXY`,
`HTTPS_PROXY`, and `ALL_PROXY` variables), never enable location following or connect
rewrites, capture the status explicitly, and accept only 2xx. This applies to model
generation, embeddings, pulls, and `/api/tags`.

`localhost` does not go through ambient DNS or `/etc/hosts`: the normalized endpoint pins its
socket to `127.0.0.1` while preserving the original Host header and HTTPS SNI/certificate
name. Shell calls use the equivalent explicit `--resolve` mapping. Literal `127/8` and `::1`
addresses connect directly.

Configuration and redirect errors name `OLLAMA_URL` and the violated rule but do not echo
credentials, response bodies, prompts, or other secrets.

### Tests

- Accept `localhost`, `localhost.`, `127.0.0.1`, another `127/8` literal, and `::1`.
- Accept explicit ports, HTTPS, and a local base path.
- Reject public/LAN IPv4, non-loopback IPv6, ordinary hostnames, wildcard addresses,
  credentials, invalid schemes, queries, fragments, percent-encoded hosts, IPv6 zone IDs,
  and every non-canonical numeric IPv4 spelling.
- Prove configuration initialization and provider construction fail before any database,
  filesystem mutation (apart from permitted read-only configuration loading), or network
  effect.
- Prove cloud-only runtime startup and installer `--no-ollama` both reject an explicitly
  configured invalid URL, while `--no-ollama` with unset/default configuration makes zero
  Ollama network requests.
- Run local 307 and 308 fixtures whose `Location` targets LAN/public listeners; assert the
  second listener receives zero requests from TypeScript generation, embedding, verifier,
  installer, and `up.sh` paths.
- Point every upper/lower-case HTTP/HTTPS/ALL proxy variable at a remote-proxy tripwire and
  assert it receives zero headers or body bytes from generation, embedding, verifier, pull,
  installer, and `up.sh`; the direct loopback fixture must still receive the request.
- Point `CURL_HOME` at a hostile `.curlrc` containing `location` and `connect-to` directives;
  installer/up still contact only the validated loopback fixture and the remote tripwire
  receives zero bytes.
- Inject a resolver/hosts mapping that would send `localhost` to a remote tripwire; TypeScript
  and shell paths pin the connection to loopback while preserving localhost Host/SNI, and the
  tripwire receives zero bytes.
- Prove shell status handling rejects a non-followed 3xx and preserves installer exit/output
  contracts.
- Run the shared URL corpus against TypeScript and shell validators, including a fresh-machine
  dry-run with no Bun.
- With invalid values supplied separately through the environment and existing `.env`, prove
  installer/up preflight exits before a sentinel Bun install, dependency write, service start,
  Postgres call, `.env` write, or network request.
- Run `bun run src/cli.ts migrate` and a non-model read command with invalid configuration;
  both emit fixed `ERROR:`/`FIX:`, exit 40, and make zero database/filesystem-mutation/network
  calls.
- Set ambient `OLLAMA_HOST` to a remote listener and prove reachability checks, pulls, and
  server launch make zero requests/binds outside the validated loopback authority.
- Preserve the existing rule that genuine local Ollama calls create no cloud-egress event.

## H3 — Repository-stable data root

### Problem

Repo-root `.env` loading already works from a foreign cwd, but the default data directory is
`${process.cwd()}/data`. A globally registered MCP server can therefore connect to the
intended database while reading, writing, watching, and backing up a different archive.

### Design

Compute and export one canonical repository root from `import.meta.url`:

```text
src/util/config.ts -> ../.. -> repository root
```

Trim the configured value once, then resolve `dataDir` as follows:

- `MINIME_DATA_DIR` unset, empty, or whitespace-only: `<repo-root>/data`;
- absolute `MINIME_DATA_DIR`: normalize it without changing its target;
- relative `MINIME_DATA_DIR`: trim and resolve it against the repository root, never process
  cwd.

Use the same repository-root value for fallback `.env` loading so the two defaults cannot
drift. `dbSnapshot()` currently stages `pg_dump` under `process.cwd()/db-dump`; replace that
with an exported `<repo-root>/db-dump` path so restic cannot combine the stable archive with
a cwd-dependent database dump. The dump directory remains temporary operational state and
is not moved into `data/`.

The exported dump root is mandatory for every repository-owned persistent/pre-image dump:
`src/pipeline/backup.ts`, the default path in `scripts/repair.ts`, and pre-promote dumps in
`scripts/promote-restore.sh`. TypeScript imports the exported path; shell scripts derive the
same physical repository root from their own absolute script location before `cd` or other
work. Explicit test-only `runRepair(..., {dumpDir})` injection remains available. Temporary
restore-drill directories and restic extraction targets are not persistent dump roots and
remain isolated temporary directories.

Every plaintext dump uses private permissions (`0700` directory, `0600` file or `umask 077`).
`restore-drill.sh` replaces its predictable `/tmp/minime-drill-dump.sql` with a
`mktemp -d` workspace and unconditional `EXIT` cleanup for both fresh-dump and restic paths.
`restore-pitr.sh` applies the same private workspace/cleanup rule to all restored and replay
error artifacts. Success, validation failure, signal, and early exit must not leave plaintext
dump files in `/tmp` or the caller's cwd.

Document the behavior in `.env.example`, `AGENTS.md`, the owner guide, and MCP registration
examples. Existing installations launched from the repository root keep the same paths; no
data is moved.

### Tests

- Import config in a subprocess whose cwd is a temporary foreign directory and prove the
  default still points to the repository data directory.
- Prove an absolute override is honored.
- Prove a relative override resolves from repository root.
- Prove empty and whitespace-only overrides use the repository default.
- Prove capture, brain, and backup consumers continue to derive their paths from
  `config.dataDir`.
- From a foreign cwd, prove `dbSnapshot()` stages and backs up `<repo-root>/db-dump`, never a
  cwd-local directory.
- From a foreign cwd, prove repair pre-images and pre-promote dumps also land under the same
  repository dump root; no tier-0 plaintext dump is created beneath the caller's cwd.
- Exercise restore-drill/PITR success and injected-failure exits with a controlled temporary
  root; assert private modes while present and zero dump/replay artifacts after exit.

## H4 — Durable attempt audit before tool execution

### Problem

`invokeTool()` currently runs a handler and then writes its audit event. If the handler
commits a mutation and the audit insert fails, state can change without a durable audit row.
Returning `INTERNAL` in that case can also encourage a duplicate retry.

Strict transaction coupling is not selected: handlers can touch PostgreSQL, files, model
providers, and indexing, so one database transaction cannot make the whole call atomic
without a large and misleading abstraction.

### Design

Use two append-only audit phases:

1. `tool:<name>:attempt` at raw MCP `tools/call` receipt, before SDK tool-input validation,
   timezone parsing, or handler execution;
2. the existing `tool:<name>` result/error event after the handler or SDK refusal and before
   any response bytes are released.

Attempt payload:

```json
{
  "params_hash": "<16-char sha256 prefix>",
  "requested_name_hash": "<optional unknown-name hash>"
}
```

Result payload remains compatible:

```json
{
  "params_hash": "...",
  "returned_ids": [],
  "returned_count": 0,
  "error": "optional structured code",
  "outcome": "optional cancellation/disconnect outcome",
  "requested_name_hash": "<optional unknown-name hash>"
}
```

For an unknown/non-string requested name, `requested_name_hash` is the first 16 lowercase hex
characters of SHA-256 over UTF-8 `JSON.stringify(raw params.name ?? null)`. It is present in
both attempt and result payloads for that call and omitted for known tools. The raw requested
name never enters an event verb or payload.

Rules:

- If attempt audit fails, do not forward the request to the SDK, parse it, or execute the
  handler; return the fixed error result defined below.
- Attempt events never contain raw parameters, contents, or returned IDs.
- A normal response is not released until its result event is durable. This includes SDK
  refusals for unknown tools, malformed tool arguments, and invalid timezones.
- Handler completion writes its result event before returning to the SDK, independently of
  whether the SDK later emits or suppresses a response.
- If result-audit insertion fails after a successful handler, withhold the entire envelope,
  including data and source IDs, and use the fixed completion acknowledgement below. This
  tells mutation clients that execution completed without leaking unaudited rows or
  encouraging a duplicate retry.
- If result-audit insertion fails for an error response, use the fixed audit error below.
- Access-frequency ranking continues to consume only the existing exact
  `tool:minime_get_context` result verb, never attempt events.
- Existing result-event shapes and meanings remain unchanged.
- Known tools use `tool:<name>:attempt` / `tool:<name>`; unknown names use
  `tool:unknown:attempt` / `tool:unknown`, with only a hash of the requested name in the
  payload, preventing arbitrary event-verb creation.

Fixed wire results are valid MCP `CallToolResult` values:

- attempt failure: `isError:true`, one text content block containing
  `{"error":{"code":"INTERNAL","message":"Tool unavailable before execution.","retry":true}}`;
- successful handler plus result-audit failure: `isError:false`, one text block containing
  `{"data":{"status":"completed_result_withheld","retry":false},"sources":[],"gaps":["completion audit unavailable; result withheld"]}`;
- handler/refusal error plus result-audit failure: `isError:true`, one text block containing
  `{"error":{"code":"AUDIT_UNAVAILABLE","message":"Tool result withheld because completion audit is unavailable.","retry":false}}`.

Those are the entire text payloads; they contain no tool parameters, response data, raw error,
row/source ID, title, path, or actor. Normal success/error wire shapes remain unchanged.

The boundary is receipt of a schema-valid JSON-RPC message whose method is `tools/call`, not
SDK tool-specific validation or callback start. Malformed JSON that cannot become an MCP
message is a transport error, not a tool call.

`buildServer()` returns a Minime server facade whose `connect(transport)` wraps **every** MCP
transport, including stdio and `InMemoryTransport`, in one audited call gateway. There is no
bare production/test connection path. The facade retains the current connect/close behavior
needed by callers; the underlying high-level `McpServer` and its direct `connect` method are
private implementation details and are never returned or exported.

The gateway and a shared `AuditCoordinator` correlate inbound request IDs, callbacks,
cancellations, closes, and outbound SDK refusals:

1. recognize a JSON-RPC request whose method is `tools/call`;
2. hash its raw `params.arguments` (or raw `params` when arguments are malformed), write the
   attempt, and only then forward the unchanged message to `McpServer`;
3. pass `extra.requestId` from the registered tool callback to the coordinator, which marks
   handler start, runs the tool, and writes the result event before returning a response to
   the SDK;
4. for SDK refusals that never reach a tool callback, hold the outbound response, write the
   error result event, then release or replace it according to the rules above.

When an outbound response belongs to a coordinator entry already terminal-audited by the
callback, the gateway only releases/drops it and never writes another event. The outbound
fallback owns result auditing solely for calls that never entered a registered callback.

The gateway preserves the current high-level `McpServer`, `tools/list` JSON schemas, client
name/version actor, timezone behavior, task/refusal semantics, and output shape. Transport
ordering is serialized per request ID; one call's audit delay does not reorder another call's
attempt and result.

The coordinator owns these terminal rules:

- State transitions for one `(transport, requestId)` are serialized, so callback-start versus
  cancellation/close has one winner and exactly one terminal result-audit attempt.
- A cancellation or transport close received while attempt insertion is pending is queued.
  After the attempt is durable, the call is finalized respectively as
  `cancelled_before_execution` or `transport_closed_before_execution`, a result event with no
  IDs is written, and the handler is never forwarded.
- Cancellation after forwarding but before callback start marks the call terminal; the
  coordinator writes one `cancelled_before_execution` result with zero IDs, and the callback
  checks terminal state and cannot begin the handler.
- Cancellation or transport close while a handler is running does not discard the pending
  call. Handler completion still writes exactly one result event. If cancellation/close was
  observed before result insertion, returned IDs are empty and outcome is respectively
  `completed_not_released` or `completed_after_disconnect`; the SDK response is suppressed or
  dropped.
- If cancellation arrives only after a normal result event is durable, the event may
  conservatively contain IDs authorized for release even when the SDK suppresses the final
  response. Auditing may over-report a disclosure in that race, never under-report one.
- Close before handler start writes `transport_closed_before_execution` with no IDs and
  prevents later execution. Close after handler start retains the pending entry until handler
  completion and result-audit attempt, then removes it.
- A duplicate in-flight request ID receives its own audit attempt and
  `DUPLICATE_REQUEST_ID` result event without replacing or executing the original call. It
  receives no second same-ID wire response, which would be uncorrelatable; after both audit
  writes the gateway closes that transport under the protocol-error path. The original call
  either remains unstarted and is finalized by close, or, if already running, completes and
  is audited after disconnect. Request-ID reuse is allowed only after terminal cleanup.
- If the process itself crashes, the durable attempt without a result is the honest incomplete
  marker; no in-process design claims to survive abrupt process death.

To avoid duplicate events, split the current registry entry point:

- `executeTool()` performs timezone/schema validation, handler execution, redaction, and
  structured error conversion but writes no audit event;
- the MCP callback enters the coordinator's already-attempted completion path around
  `executeTool()` and writes the one result event before returning;
- public `invokeTool()` remains the non-transport/test-harness entry point and wraps
  `executeTool()` in the same two-phase state machine, including pre-release withholding.

Returned IDs come only from the final redacted envelope authorized for release, not raw handler
state. Pending metadata stores only transport identity, request ID, actor, canonical tool verb,
parameter hash, and state flags—never parameters or content—and is removed after its one
terminal result-audit attempt. Cancellation notifications are ordered behind a still-pending
attempt for the same request, so the SDK never sees a cancellation before the original call.

Split implementation into three bounded cards:

1. audit event API and call-state machine;
2. transport-agnostic server facade/gateway, correlation, cancellation/close handling, and
   exact schema/wire compatibility;
3. leak, access-ranking, invalid-call, race, and failure-injection regression coverage.

This design guarantees durable audit intent before any side effect and a durable disclosure
record before any row data or source ID leaves. It does not claim cross-resource
transactional atomicity.

### Test seam

Use a phase-specific internal dependency:

```text
AuditSink.attempt(actor, tool, params, requestedNameHash?)
AuditSink.result(actor, tool, paramsHash, returnedIds, error?, outcome?, requestedNameHash?)
```

Production defaults to append-only events. The direct `invokeTool()` test harness and the
transport gateway share the same state machine; tests inject attempt-only or result-only
failures without altering the database role. The raw transport path remains covered by
both in-memory and stdio client/server integration tests rather than being inferred from
callback tests.

### Tests

- Attempt failure leaves a handler-side counter and filesystem sentinel untouched.
- Successful attempt precedes handler execution.
- Handler success plus result-audit failure returns only the fixed completion
  acknowledgement; no data, source ID, title, or row value is present.
- Handler error plus result-audit failure returns only the fixed audit error.
- Tool-specific bad input, malformed raw arguments, invalid timezone, and an unknown tool
  each write one attempt and one error result without exposing input.
- Unknown/non-string tool names are absent from verbs/payloads while the exact expected
  `requested_name_hash` appears in both events.
- Normal MCP calls create one attempt and one compatible result event.
- The existing in-memory M2 client continues to create exactly one attempt/result pair through
  `buildServer().connect()`, proving no transport can bypass the gateway.
- The raw SDK server is not exported/reachable; repository call sites and tests connect only
  through the facade.
- Cancellation while attempt insertion is paused writes a cancellation result, executes no
  handler, emits no response data, and leaves no pending entry.
- Cancellation after forwarding but before a barrier-controlled callback start also writes
  one zero-ID cancellation result and executes no handler.
- Cancellation after a barrier-controlled handler mutation but before return writes one
  `completed_not_released` result with zero IDs, releases no payload, and leaves no pending
  entry.
- Closing the transport after a barrier-controlled mutation still produces one
  `completed_after_disconnect` result after handler completion and cleans up.
- A raw client concurrent duplicate request ID executes at most the original, records the
  duplicate attempt/refusal, receives no misleading duplicate same-ID result, and observes
  transport close; the original's terminal audit remains correctly correlated.
- `tools/list` schemas are byte-for-byte structurally equal before and after the refactor.
- Access-count ranking ignores attempts.
- The 200-call leak suite still returns no tier-0/tier-2 content while locked and all calls
  have exactly one durable attempt and one result unless a phase is intentionally failed.

## H5 — Production-shaped contradiction pairing

### Problem

`chunkPairsSharingPerson()` requires `mentions` edges with
`source_table='chunks'` and `source_id=chunk.id`. Production extraction writes
parent-anchored edges: the edge source is the typed parent row and its source table/ID.
The nightly contradiction scan therefore has no production-shaped pairs to evaluate.

### Design

Build pairs from the shape the extractor actually writes:

1. select two distinct `mentions` edges whose destination is the same person;
2. identify each source parent by the composite key `(src_type, src_id)` and require distinct
   composite keys;
3. join each edge's `src_type/src_id` to its parent chunks;
4. retain only chunks that contain the person's canonical name or an alias using
   case-folded literal substring matching (`strpos(lower(text), lower(name)) > 0`), never
   SQL `LIKE`/`ILIKE`, so `%`, `_`, and backslashes are ordinary characters;
   empty and whitespace-only names are excluded before matching;
5. exclude compiled page parents whose source is `dream:notes` or
   `dream:decision-digest`, plus UUID-suffixed compiled-note paths and legacy
   `derived/notes/` pages with the canonical system marker/Sources shape. This defense remains
   effective if `brainSync()` imported an archive before H1 repaired its provenance, so
   derived summaries are not treated as independent evidence;
6. tolerate legacy `source_table='chunks'` edges by relying on the canonical parent tuple
   and ignoring the historical source-table/source-ID representation;
7. canonicalize each pair by lexicographic chunk ID and remove duplicates;
8. order by newest participating chunk descending, then canonical `a_id`, `b_id`, and
   `person_id` ascending;
9. apply the existing work limit after deduplication.

Literal substring semantics are deliberate. They work for punctuation-heavy aliases and CJK
names where SQL word boundaries are unreliable; entity extraction remains the primary
precision gate.

The result shape remains:

```text
person_id, a_id, a_text, a_tier, b_id, b_text, b_tier
```

`contradictionScan()` keeps the maximum-pair-tier route, cloud ceiling behavior, mock
antonym detector, existing dedupe check, and IDs-only review payload. It remains flag-only.

### Tests

- Two independently indexed parent rows mentioning the same person produce one pair using
  real `extractAndLink()` output.
- Contradictory statements queue exactly one review item.
- Re-running is idempotent.
- Two chunks from the same parent do not pair.
- Different people do not pair.
- Alias mentions resolve to the canonical person.
- Aliases containing `%`, `_`, apostrophes, backslashes, mixed case, punctuation, and CJK
  text match literally and do not act as wildcards.
- Two parents with the same textual ID but different `src_type` remain distinct; two chunks
  under one composite parent never pair.
- Derived compiled-note parents are excluded even with temporary `source='brain-sync'`
  provenance, while a legacy chunk-anchored fixture remains compatible.
- Pair tier is the maximum source tier and existing per-tier routing tests remain green.
- The SQL limit applies after pair deduplication and the complete four-key ordering is
  deterministic under timestamp ties.

## Documentation and decision records

- Record the owner-approved hardening-only Sol/Luna role override on this design branch.
- Each fix branch appends its own `DECISIONS.md` entry and updates only its affected
  `docs/SUBSYSTEMS.md` inventory rows. A branch never claims a later branch's decision:
  - H2 records loopback-only Ollama, redirect refusal, and shell parity;
  - H3 records repository-relative archive and dump staging;
  - H1 records canonical compiled archives and reconciliation recovery;
  - H4 records raw-receipt attempt plus pre-release result auditing;
  - H5 records production parent-pair and literal-name semantics.
- No new subsystem is introduced.
- Unrelated scorecard or prior-work cleanup is outside these branches.
- Keep historical decisions append-only; do not rewrite older accepted gaps.

## Branch acceptance gate

Before merging each fix branch:

1. targeted regression test demonstrates red before the production change;
2. targeted suite is green;
3. `bun test` is green;
4. `bunx tsc --noEmit` is clean;
5. `bunx biome check .` is clean without fixes required;
6. `git diff --check` is clean;
7. `make check-subsystems` is green;
8. `make verify` is green, including offline MinimeBench floors;
9. `first_pass_reviewer_luna` has no unresolved critical/important findings;
10. any Luna-raised disputed Critical is closed by an independent
    `critical_adjudicator_sol`;
11. `final_reviewer_sol` returns binding PASS. Its BLOCK is final for that cycle and cannot
    be waived by the primary session or adjudicator.

After all five branches merge, run the full gate once more on the integrated base. Only then
author the detailed W5 design and implementation plan.

## Rollback and operational safety

- Every fix is a separate commit/branch and can be reverted independently.
- Tests use `minime_test`, temporary data directories, mock Ollama, and scratch eval databases.
- No command reads or mutates owner tier-0/tier-2 contents.
- No repair script or live migration is required for these fixes.
- Legacy compiled-note archive repair is idempotent and performed by the normal dream job.
- Reverting H4 reverts code only. Append-only attempt/result events already written remain
  historical audit records and are never deleted during rollback.
- Existing untracked agent configuration and benchmark files are preserved.
