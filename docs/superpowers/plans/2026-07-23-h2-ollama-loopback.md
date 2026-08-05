# H2 Loopback-Only Ollama Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every configured Ollama path visibly loopback-only, direct-socket, proxy-independent, and redirect-refusing before any Minime side effect can occur.

**Architecture:** A committed TSV corpus defines one URL contract implemented by a pure TypeScript validator and a dependency-free Bash validator. Runtime provider/verifier traffic uses a dedicated `node:http`/`node:https` helper that pins `localhost` to `127.0.0.1`; bootstrap traffic uses one hardened curl wrapper with the same endpoint normalization, explicit resolve/Host behavior, no proxies/config/redirects, and 2xx-only status handling.

**Tech Stack:** Bun/TypeScript, `node:http`, `node:https`, Bash 3.2, curl, existing `LlmProvider`/`FetchFn` test seams, `bun test`.

## Global Constraints

- Start branch `codex/hardening-ollama-loopback` at the exact binding-approved
  `PLAN_BASE_SHA`; require `80760f6` to be its ancestor, but never start or diff H2 directly
  from `80760f6`.
- Use the pinned ignored worktree `.claude/worktrees/hardening-ollama-loopback`, record
  `START_SHA=PLAN_BASE_SHA`, and scope every status, ledger, diff, gate, and review command
  to that worktree.
- Accepted schemes are exactly `http:` and `https:`.
- Credentials, query strings, fragments, percent-encoded authority bytes, IPv6 zone IDs, and ambiguous numeric hosts are rejected.
- Raw ASCII C0/DEL control characters are rejected before trimming, regex matching, or URL parsing in both TypeScript and Bash.
- After shared dotenv trimming/comment parsing, the complete endpoint must contain only
  printable ASCII bytes `0x21..0x7e`; literal internal spaces and all non-ASCII bytes fail
  with the fixed `endpoint_byte` rule before WHATWG/regex/path normalization. Percent-encoded
  space/non-ASCII remains ASCII source text and is accepted unchanged.
- TypeScript and Bash share one raw-path preparse before any WHATWG/URL normalization:
  split the untouched path on literal `/`, reject a literal `\` anywhere, reject segments
  exactly `.` or `..`, reject every raw percent escape decoding to `.`, `/`, or `\` anywhere
  in the path (case-insensitive `%2e`, `%2f`, `%5c`, including `%2e` embedded in a segment),
  then permit the remaining path bytes unchanged. This exact rule is
  implemented once per language from the shared corpus; neither implementation may rely on
  a parser's dot-segment or backslash normalization.
- The only accepted trailing-dot spelling is one trailing dot on the unbracketed DNS token
  `localhost` (case-folded before comparison). A trailing dot is never legal inside a
  bracketed authority, including `[::1.]`, and it is not accepted on numeric IPv4. After
  that one permitted `localhost.` normalization, accepted hosts are `localhost`, canonical
  four-octet dotted-decimal `127.0.0.0/8`, and bracketed IPv6 `::1`.
- Integer, hexadecimal, octal, shortened, and leading-zero IPv4 spellings are rejected even when a URL parser normalizes them to loopback.
- Explicit ports and local base paths remain supported.
- No DNS resolution is used to decide locality; `localhost` sockets pin to `127.0.0.1`.
- Runtime and shell preserve the configured Host authority; HTTPS uses normalized `localhost` for SNI/certificate verification.
- Every 3xx response is terminal; no Ollama request follows a redirect.
- Runtime Ollama I/O does not use ambient `fetch`; shell Ollama I/O ignores curl config, every upper/lower HTTP/HTTPS/ALL proxy variable, and ambient `OLLAMA_HOST`.
- Every CLI command validates configured `OLLAMA_URL`, including cloud-only, mocked, migrate, audit, and non-model commands.
- CLI preflight is the first executable line of `main()` after read-only module/config loading and exits 40 with fixed `ERROR:`/`FIX:` text.
- Provider construction repeats the pure guard for library callers.
- Installer/up preflight runs before Bun/dependency/service/Postgres/filesystem/network work; installer failure uses `[1/9] FAIL env`, exit 40, and the existing final `ERROR:`/`FIX:` shape.
- `--no-ollama` suppresses all Ollama network work but does not suppress validation of an explicitly configured URL.
- Unset configuration uses `http://localhost:11434`; shell precedence is exported environment, safely parsed repository `.env`, then default.
- Shell `.env` parsing matches `parseDotenv()` exactly for duplicate keys and unquoted
  inline comments: the last `OLLAMA_URL` assignment wins, and the first whitespace-`#`
  sequence starts the comment. An earlier safe value can never mask a later remote value.
- A base-path or HTTPS endpoint is treated as an existing proxy and never causes a new plain `ollama serve`.
- Only a root-path HTTP endpoint may launch `ollama serve`, with an explicit validated loopback bind.
- Model pulls use `POST /api/pull` with `stream:false`; no unconstrained `ollama pull` remains.
- Configuration/redirect errors never echo the configured URL, credentials, response bodies, prompts, or model output.
- Fixed configuration error/fix text is defined once per runtime surface (one TypeScript
  formatter and one shell helper in `scripts/lib.sh`); CLI, verifier, installer, and `up.sh`
  call those helpers and never inline raw URL/error output.
- Genuine local Ollama calls still create no `egress:*` event.
- No new package, cloud endpoint, migration, subsystem, remote/LAN Ollama mode, or owner-data access.

---

## File and responsibility map

| File | Action | Responsibility |
|---|---|---|
| `fixtures/ollama-url-corpus.tsv` | Create | One acceptance/rejection corpus shared by TypeScript and Bash tests |
| `src/util/ollama-url.ts` | Create | Pure URL validation/normalization and fixed CLI error formatter |
| `test/h2.ollama-url.test.ts` | Create | Corpus parity, provider guard, CLI/m0/install/up preflight ordering |
| `src/cli.ts` | Modify | First-line non-throwing preflight and exit 40 |
| `src/llm/ollama.ts` | Modify | Repeat construction guard and route default I/O to direct helper |
| `src/llm/ollama-http.ts` | Create | Direct `node:http`/`node:https` request helper, localhost pinning, redirect refusal |
| `src/verify/m0.ts` | Modify | Validate before DB and use the direct helper for `/api/tags` |
| `test/h2.ollama-http.test.ts` | Create | Redirect/proxy/DNS/Host/base-path/generation/embedding/verifier integration fixtures |
| `test/providers.test.ts` | Modify | Preserve injected `FetchFn` request-shape and zero-egress tests |
| `scripts/lib.sh` | Modify | Safe `.env` precedence, Bash validator, normalized endpoint, hardened curl/tags/pull helpers |
| `scripts/install.sh` | Modify | Step-1 preflight, HTTP pulls, explicit safe server launch, no ambient `OLLAMA_HOST` |
| `scripts/up.sh` | Modify | Immediate preflight and hardened tags checks |
| `test/h2.ollama-shell.test.ts` | Create | Shell corpus, no-Bun dry run, invalid env/.env ordering, proxy/curlrc/redirect/launch/pull fixtures |
| `test/install.test.ts` | Modify | Exit/output and `--no-ollama` assertions |
| `.env.example` | Modify | State the loopback-only URL grammar |
| `AGENTS.md` | Modify | State the loopback/no-proxy/no-redirect operator contract |
| `DECISIONS.md` | Modify | Append the H2 decision only |
| `docs/SUBSYSTEMS.md` | Modify | Update only Provider layer + egress audit maintenance/dependencies |

## Exact interfaces

`src/util/ollama-url.ts` produces:

```ts
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

export interface OllamaEndpoint {
  protocol: "http:" | "https:";
  hostname: "localhost" | string;
  connectHost: "127.0.0.1" | string;
  port: number;
  hostHeader: string;
  basePath: string;
  serverName?: string;
  canLaunchServer: boolean;
  bindAuthority: string;
}

export class OllamaUrlError extends Error {
  readonly rule: OllamaUrlRule;
}

export function validateOllamaUrl(raw: string): OllamaEndpoint;
export function ollamaApiUrl(endpoint: OllamaEndpoint, apiPath: `/${string}`): string;
export function ollamaPreflight(raw: string):
  | { ok: true; endpoint: OllamaEndpoint }
  | {
      ok: false;
      exitCode: 40;
      rule: OllamaUrlRule;
      error: string;
      fix: string;
    };
```

`ollamaPreflight()` is the sole TypeScript formatter for the fixed `ERROR:`/`FIX:` pair;
callers print its returned strings verbatim. The shell counterpart is one
`ollama_preflight_error()`/`ollama_preflight_fix()` helper pair in `scripts/lib.sh`; both
`scripts/install.sh` and `scripts/up.sh` call it rather than carrying a second copy. Neither
formatter includes the raw URL, authority, response body, or exception text.

Fixed rejection output:

```text
ERROR: OLLAMA_URL is invalid for local Ollama (<rule>).
FIX: set OLLAMA_URL=http://localhost:11434 (or another canonical loopback literal), then retry.
```

The parenthesized rule is one fixed `OllamaUrlRule`, never the raw value.

`src/llm/ollama-http.ts` produces:

```ts
export interface OllamaRequestOptions {
  timeoutMs?: number;
}

export function ollamaNodeRequestOptions(
  endpoint: OllamaEndpoint,
  apiPath: `/${string}`,
  init?: RequestInit,
): import("node:http").RequestOptions;

export async function ollamaRequest(
  endpoint: OllamaEndpoint,
  apiPath: `/${string}`,
  init?: RequestInit,
  options?: OllamaRequestOptions,
): Promise<Response>;

export async function fetchOllamaTags(
  endpoint: OllamaEndpoint,
  options?: OllamaRequestOptions,
): Promise<string[]>;
```

`scripts/lib.sh` produces these sourceable functions/globals:

```bash
resolve_ollama_url                 # environment > safe .env > default
validate_ollama_url "$value"       # 0 accepted; nonzero + OLLAMA_URL_RULE
ollama_preflight                   # validates resolved OLLAMA_URL
ollama_api_url "/api/tags"         # prints normalized local request URL
ollama_request GET "/api/tags" "" "$output_file"
ollama_reachable
ollama_has_model "$model"
ollama_pull_model "$model" "$timeout"

OLLAMA_SCHEME
OLLAMA_NORMALIZED_HOST
OLLAMA_CONNECT_HOST
OLLAMA_PORT
OLLAMA_HOST_HEADER
OLLAMA_BASE_PATH
OLLAMA_CAN_LAUNCH
OLLAMA_BIND_AUTHORITY
```

### Task 1: Lock the shared URL grammar and preflight order

**Files:**
- Create: `fixtures/ollama-url-corpus.tsv`
- Create: `src/util/ollama-url.ts`
- Create: `test/h2.ollama-url.test.ts`
- Modify: `src/cli.ts`
- Modify: `src/llm/ollama.ts`
- Modify: `src/verify/m0.ts`
- Modify: `scripts/lib.sh`
- Modify: `scripts/install.sh`
- Modify: `scripts/up.sh`

**Interfaces:**
- Produces: `validateOllamaUrl()`, `ollamaPreflight()`, shell `validate_ollama_url`/`ollama_preflight`, provider/CLI/verifier/bootstrap fail-closed guards

- [ ] **Step 1: Commit the normative table-driven corpus as the first red artifact**

Create `fixtures/ollama-url-corpus.tsv` exactly as:

```tsv
# verdict	rule	url
accept	ok	http://localhost:11434
accept	ok	https://LOCALHOST.
accept	ok	http://localhost.:11434/base/path
accept	ok	http://localhost:11434/v1.2/model..name
accept	ok	http://localhost:11434/base/%252e/%255c-safe
accept	ok	http://127.0.0.1
accept	ok	http://127.255.2.3:11434
accept	ok	http://[::1]:11434
accept	ok	https://localhost:9443/ollama
reject	surrounding_whitespace	 http://localhost:11434
reject	scheme	ftp://localhost:11434
reject	credentials	http://user@localhost:11434
reject	credentials	http://user:pass@localhost:11434
reject	query_or_fragment	http://localhost:11434?x=1
reject	query_or_fragment	http://localhost:11434/#frag
reject	path_segment	http://localhost:11434/.
reject	path_segment	http://localhost:11434/..
reject	path_segment	http://localhost:11434/base/./models
reject	path_segment	http://localhost:11434/base/../models
reject	path_segment	http://localhost:11434/%2e
reject	path_segment	http://localhost:11434/%2E%2E/models
reject	path_segment	http://localhost:11434/base/%2e%2e/models
reject	path_segment	http://localhost:11434/%2efoo
reject	path_segment	http://localhost:11434/a%2eb
reject	path_segment	http://localhost:11434/base/nested/%2E%2efoo
reject	path_segment	http://localhost:11434/base/%2fmodels
reject	path_segment	http://localhost:11434/base/%5Cmodels
reject	path_segment	http://localhost:11434/base\..\models
reject	authority_encoding	http://local%68ost:11434
reject	authority_encoding	http://[fe80::1%25lo0]:11434
reject	non_loopback_host	http://0.0.0.0:11434
reject	non_loopback_host	http://192.168.1.5:11434
reject	non_loopback_host	http://8.8.8.8:11434
reject	non_loopback_host	http://[::]:11434
reject	non_loopback_host	http://[::2]:11434
reject	non_loopback_host	http://[::ffff:127.0.0.1]:11434
reject	syntax	http://[::1.]:11434
reject	syntax	http://[127.0.0.1]:11434
reject	syntax	http://[localhost.]:11434
reject	syntax	http://127.0.0.1.:11434
reject	non_loopback_host	http://ollama.internal:11434
reject	non_loopback_host	http://host.docker.internal:11434
reject	ambiguous_numeric_host	http://2130706433:11434
reject	ambiguous_numeric_host	http://0x7f000001:11434
reject	ambiguous_numeric_host	http://0177.0.0.1:11434
reject	ambiguous_numeric_host	http://127.1:11434
reject	ambiguous_numeric_host	http://127.0.1:11434
reject	ambiguous_numeric_host	http://127.000.000.001:11434
reject	port	http://localhost:0
reject	port	http://localhost:65536
reject	syntax	http://localhost..:11434
reject	syntax	http://[::1
accept	ok	http://localhost:11434/base%20path
accept	ok	http://localhost:11434/base/%C3%A9
accept	ok	http://localhost:11434/a.b
reject	endpoint_byte	http://localhost:11434/base path
reject	endpoint_byte	http://localhost:11434/base/é
reject	endpoint_byte	http://localhost:11434/base/你好
reject	control_character	http://local<TAB>host:11434
reject	control_character	http://localhost:11434<LF>/api
reject	control_character	http://localhost:11434<CR>
reject	control_character	http://localhost:11434<US>
reject	control_character	http://localhost:11434<DEL>
reject	empty	<EMPTY>
```

The test reader ignores only lines beginning with `#`; it does not trim the URL column.
`<EMPTY>` is the sole corpus encoding for the empty string. It decodes `<TAB>`, `<LF>`,
`<CR>`, `<US>`, and `<DEL>` to bytes `0x09`, `0x0a`, `0x0d`, `0x1f`, and `0x7f`
respectively before passing the exact value to either implementation. NUL cannot cross the Unix process
environment/argv ABI into Bash; add a TypeScript-only `"\0"` assertion beside the shared
control-byte rows. Literal internal space and every UTF-8 byte above `0x7e` use the fixed
`endpoint_byte` rule; percent-encoded space (`%20`) and percent-encoded UTF-8 (`%C3%A9`) are
ASCII source bytes and remain accepted unchanged. Leading/trailing dotenv whitespace is
handled only by the shared dotenv parser/trim semantics; a quoted value's internal space is
still rejected by the endpoint validator.

The `path_segment` rows are tested by the shared raw-path preparse before WHATWG parsing or
path cleanup. Literal `.`/`..` segments, every raw percent-encoded dot occurrence (including
`%2e` embedded in a segment), percent-encoded `/` or `\` separators, and literal backslashes
are all rejected; `%252e` and `%255c` remain ordinary data because the rule decodes exactly
one percent layer. Ordinary literal-dot base-path segments remain valid. This prevents TypeScript's WHATWG dot-segment/backslash
normalization from silently producing a different request path than Bash.

- [ ] **Step 2: Write the TypeScript/Bash parity and side-effect-order tests**

Create `test/h2.ollama-url.test.ts` with:

```ts
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ollamaProvider } from "../src/llm/ollama";
import { config, parseDotenv } from "../src/util/config";
import {
  OllamaUrlError,
  ollamaPreflight,
  validateOllamaUrl,
} from "../src/util/ollama-url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");

interface CorpusRow {
  verdict: "accept" | "reject";
  rule: string;
  url: string;
}

function corpus(): CorpusRow[] {
  const decode = (value: string): string =>
    value
      .replaceAll("<TAB>", "\t")
      .replaceAll("<LF>", "\n")
      .replaceAll("<CR>", "\r")
      .replaceAll("<US>", "\x1f")
      .replaceAll("<DEL>", "\x7f");
  return readFileSync(join(REPO, "fixtures/ollama-url-corpus.tsv"), "utf8")
    .split("\n")
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => {
      const [verdict, rule, encodedUrl = ""] = line.split("\t");
      return {
        verdict: verdict as CorpusRow["verdict"],
        rule: rule!,
        url: encodedUrl === "<EMPTY>" ? "" : decode(encodedUrl),
      };
    });
}

function shellVerdict(url: string): { ok: boolean; rule: string } {
  const script =
    '. "$1"; if validate_ollama_url "$2"; then printf "ok\\n"; ' +
    'else printf "%s\\n" "$OLLAMA_URL_RULE"; exit 9; fi';
  const proc = Bun.spawnSync(["bash", "-c", script, "_", join(REPO, "scripts/lib.sh"), url], {
    cwd: REPO,
    env: { ...process.env, MINIME_LIB_SKIP_RESOLVE: "1" },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    ok: proc.exitCode === 0,
    rule: proc.stdout.toString().trim(),
  };
}

describe("normative Ollama URL corpus", () => {
  for (const row of corpus()) {
    test(`${row.verdict}: ${row.rule}: ${JSON.stringify(row.url)}`, () => {
      let ts: { ok: boolean; rule: string };
      try {
        validateOllamaUrl(row.url);
        ts = { ok: true, rule: "ok" };
      } catch (error) {
        expect(error).toBeInstanceOf(OllamaUrlError);
        ts = { ok: false, rule: (error as OllamaUrlError).rule };
      }
      const shell = shellVerdict(row.url);
      expect(ts.ok).toBe(row.verdict === "accept");
      expect(shell.ok).toBe(ts.ok);
      expect(ts.rule).toBe(row.rule);
      expect(shell.rule).toBe(row.rule);
    });
  }
});

test("TypeScript rejects NUL before URL parsing", () => {
  expect(() => validateOllamaUrl("http://local\0host:11434")).toThrow(
    expect.objectContaining({ rule: "control_character" }),
  );
});

test.each([
  "http://[::1.]:11434",
  "http://[127.0.0.1]:11434",
  "http://[localhost.]:11434",
  "http://127.0.0.1.:11434",
])("TS/WHATWG and Bash reject bracketed/numeric trailing-dot spellings as syntax: %s", (url) => {
  expect(() => validateOllamaUrl(url)).toThrow(
    expect.objectContaining({ rule: "syntax" }),
  );
  expect(shellVerdict(url)).toEqual({ ok: false, rule: "syntax" });
});

test.each([
  "http://localhost:11434/base path",
  "http://localhost:11434/base/é",
  "http://localhost:11434/base/你好",
])("TS/Bash reject raw endpoint bytes before normalization: %s", (url) => {
  expect(() => validateOllamaUrl(url)).toThrow(
    expect.objectContaining({ rule: "endpoint_byte" }),
  );
  expect(shellVerdict(url)).toEqual({ ok: false, rule: "endpoint_byte" });
});

test.each([
  "http://localhost:11434/%2efoo",
  "http://localhost:11434/a%2eb",
  "http://localhost:11434/base/nested/%2E%2efoo",
])("TS/Bash reject every raw percent-encoded dot occurrence before normalization: %s", (url) => {
  expect(() => validateOllamaUrl(url)).toThrow(
    expect.objectContaining({ rule: "path_segment" }),
  );
  expect(shellVerdict(url)).toEqual({ ok: false, rule: "path_segment" });
});

test("TS/Bash preserve an ordinary literal dot in a path segment", () => {
  expect(validateOllamaUrl("http://localhost:11434/a.b").basePath).toBe("/a.b");
  expect(shellVerdict("http://localhost:11434/a.b")).toEqual({ ok: true, rule: "ok" });
});

test("normalization pins localhost while preserving Host and base path", () => {
  const endpoint = validateOllamaUrl("https://LOCALHOST.:9443/ollama/");
  expect(endpoint.hostname).toBe("localhost");
  expect(endpoint.connectHost).toBe("127.0.0.1");
  expect(endpoint.hostHeader).toBe("LOCALHOST.:9443");
  expect(endpoint.serverName).toBe("localhost");
  expect(endpoint.basePath).toBe("/ollama");
  expect(endpoint.canLaunchServer).toBe(false);
});

test("provider construction repeats the guard without calling injected HTTP", () => {
  const saved = config.ollamaUrl;
  let calls = 0;
  config.ollamaUrl = "http://192.168.50.4:11434";
  try {
    expect(() =>
      ollamaProvider((async () => {
        calls++;
        return new Response("{}");
      }) as typeof fetch),
    ).toThrow(/OLLAMA_URL/);
    expect(calls).toBe(0);
  } finally {
    config.ollamaUrl = saved;
  }
});

test("preflight errors are fixed and do not echo the configured value", () => {
  const secret = "http://user:password@198.51.100.8:11434";
  const result = ollamaPreflight(secret);
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("invalid fixture unexpectedly passed");
  expect(result.exitCode).toBe(40);
  expect(result.rule).toBe("credentials");
  expect(`${result.error}\n${result.fix}`).not.toContain(secret);
  expect(`${result.error}\n${result.fix}`).not.toContain("password");
});

test.each([
  {
    name: "first loopback then remote",
    text:
      "OLLAMA_URL=http://localhost:11434\n" +
      "OLLAMA_URL=http://192.168.50.4:11434\n",
    expected: "http://192.168.50.4:11434",
    ok: false,
  },
  {
    name: "first remote then loopback",
    text:
      "OLLAMA_URL=http://192.168.50.4:11434\n" +
      "OLLAMA_URL=http://localhost:11434\n",
    expected: "http://localhost:11434",
    ok: true,
  },
  {
    name: "first whitespace-hash starts the inline comment",
    text: "OLLAMA_URL=http://localhost:11434 # first # second\n",
    expected: "http://localhost:11434",
    ok: true,
  },
  {
    name: "quoted internal space remains endpoint-invalid",
    text: 'OLLAMA_URL="http://localhost:11434/base path"\n',
    expected: "http://localhost:11434/base path",
    ok: false,
  },
  {
    name: "quoted percent-encoded space remains valid",
    text: 'OLLAMA_URL="http://localhost:11434/base%20path"\n',
    expected: "http://localhost:11434/base%20path",
    ok: true,
  },
])("shell .env parsing matches parseDotenv: $name", ({ text, expected, ok }) => {
  const cwd = mkdtempSync(join(tmpdir(), "minime-h2-dotenv-parity-"));
  try {
    writeFileSync(join(cwd, ".env"), text, { mode: 0o600 });
    const env = { ...process.env, MINIME_LIB_SKIP_RESOLVE: "1" };
    delete env.OLLAMA_URL;
    const script =
      'cd "$2"; . "$1"; unset OLLAMA_URL; resolve_ollama_url; ' +
      'if validate_ollama_url "$OLLAMA_URL"; then verdict=ok; else verdict="$OLLAMA_URL_RULE"; fi; ' +
      'printf "%s\\t%s" "$OLLAMA_URL" "$verdict"';
    const proc = Bun.spawnSync(
      ["bash", "-c", script, "_", join(REPO, "scripts/lib.sh"), cwd],
      { env, stdout: "pipe", stderr: "pipe" },
    );
    expect(proc.exitCode, proc.stderr.toString()).toBe(0);
    const [shellValue, verdict] = proc.stdout.toString().split("\t");
    expect(shellValue).toBe(parseDotenv(text).OLLAMA_URL);
    expect(shellValue).toBe(expected);
    expect(verdict === "ok").toBe(ok);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
```

Add these imports and complete subprocess cases in the same file:

```ts
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";

async function listeningSocket() {
  let connections = 0;
  const server = createServer((socket) => {
    connections += 1;
    socket.destroy();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture did not bind TCP");
  return {
    port: address.port,
    connections: () => connections,
    close: () => new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()),
    ),
  };
}

test.each([
  { argv: ["src/cli.ts", "migrate"], code: 40, cli: true },
  { argv: ["src/cli.ts", "audit", "--since", "1d"], code: 40, cli: true },
  { argv: ["src/verify/m0.ts"], code: 1, cli: false },
])("$argv preflights before DB, files, or Ollama sockets", async ({ argv, code, cli }) => {
  const db = await listeningSocket();
  const ollama = await listeningSocket();
  const cwd = mkdtempSync(join(tmpdir(), "minime-h2-preflight-"));
  const invalidUrl = `http://user:fictional-secret@127.0.0.1:${ollama.port}`;
  try {
    const proc = Bun.spawn(["bun", "run", join(REPO, argv[0]!), ...argv.slice(1)], {
      cwd,
      env: {
        ...process.env,
        NODE_ENV: "test",
        MINIME_SKIP_REPO_DOTENV: "1",
        OLLAMA_URL: invalidUrl,
        DATABASE_URL: `postgres://minime:minime@127.0.0.1:${db.port}/minime_test`,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expect(exitCode).toBe(code);
    if (cli) {
      expect(`${out}\n${err}`).toContain("ERROR: OLLAMA_URL is invalid");
      expect(`${out}\n${err}`).toContain("FIX: set OLLAMA_URL=");
    } else {
      expect(`${out}\n${err}`).toContain("FAIL  ollama url valid — credentials");
    }
    expect(`${out}\n${err}`).not.toContain(invalidUrl);
    expect(`${out}\n${err}`).not.toContain("fictional-secret");
    expect(db.connections()).toBe(0);
    expect(ollama.connections()).toBe(0);
    expect(readdirSync(cwd)).toEqual([]);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    await Promise.all([db.close(), ollama.close()]);
  }
});

test("raw-space/non-ASCII endpoint rejection prevents runtime, installer, and up requests", async () => {
  for (const invalidUrl of [
    "http://localhost:11434/base path",
    "http://localhost:11434/base/é",
    "http://localhost:11434/base/你好",
  ]) {
    const direct = await listeningSocket();
    const proxy = await listeningSocket();
    const cwd = mkdtempSync(join(tmpdir(), "minime-h2-endpoint-byte-"));
    try {
      const env = {
        ...process.env,
        NODE_ENV: "test",
        MINIME_SKIP_REPO_DOTENV: "1",
        OLLAMA_URL: invalidUrl,
        HTTP_PROXY: `http://127.0.0.1:${proxy.port}`,
        DATABASE_URL: `postgres://minime:minime@127.0.0.1:${direct.port}/minime_test`,
      };
      for (const argv of [
        ["src/cli.ts", "migrate"],
        ["scripts/install.sh", "--dry-run", "--no-ollama"],
        ["scripts/up.sh"],
      ] as const) {
        const proc = Bun.spawn(
          argv[0]!.endsWith(".sh")
            ? ["bash", join(REPO, argv[0]!), ...argv.slice(1)]
            : ["bun", "run", join(REPO, argv[0]!), ...argv.slice(1)],
          { cwd, env, stdout: "pipe", stderr: "pipe" },
        );
        const [out, err, code] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
          proc.exited,
        ]);
        expect(code).toBe(40);
        expect(`${out}\n${err}`).not.toContain(invalidUrl);
        expect(`${out}\n${err}`).not.toContain("endpoint-byte");
      }
      expect(direct.connections()).toBe(0);
      expect(proxy.connections()).toBe(0);
    } finally {
      direct.close();
      proxy.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  }
});
```

- [ ] **Step 3: Run the corpus/preflight tests red**

```bash
bun test test/h2.ollama-url.test.ts
```

Expected: FAIL because the TypeScript module/functions and Bash validator do not exist;
current provider construction accepts the remote URL; CLI reaches command dispatch; current
installer/up do not have an immediate validation exit.

- [ ] **Step 4: Implement the pure TypeScript parser**

Create `src/util/ollama-url.ts` with this parsing order:

```ts
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
  constructor(readonly rule: OllamaUrlRule) {
    super(`OLLAMA_URL is invalid for local Ollama (${rule}).`);
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
      if (byte === "2e") {
        fail("path_segment");
      }
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
  if (/[\u0000-\u001f\u007f]/.test(raw)) fail("control_character");
  if (raw !== raw.trim()) fail("surrounding_whitespace");
  // After shared dotenv trimming, only printable ASCII endpoint bytes are allowed.
  // This runs before regex/WHATWG parsing so TS and Bash retain identical path bytes.
  rejectNonPrintableAscii(raw);
  if (raw.includes("?") || raw.includes("#")) fail("query_or_fragment");
  const match = raw.match(/^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/?#]*)(\/[^?#]*)?$/);
  if (!match) fail("syntax");
  const protocol = `${match[1]!.toLowerCase()}:`;
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
  // A trailing dot is DNS syntax only for the unbracketed localhost token. Check the
  // bracketed spelling before stripping anything so WHATWG/URL cannot reinterpret [::1.].
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
    if (numericLooking(hostname) && !/^[0-9.]+$/.test(hostname))
      fail("ambiguous_numeric_host");
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
```

Do not use `new URL(raw).hostname` to decide whether an originally ambiguous numeric spelling
was safe; raw authority validation precedes parser normalization.

- [ ] **Step 5: Implement the dependency-free Bash validator and safe `.env` precedence**

At the top of `scripts/lib.sh`, replace the direct `OLLAMA_URL=...` default with:

```bash
trim_shell_value() {
  local value="$1"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "$value"
}

repo_env_value() {
  local wanted="$1" file="$2" raw line key value result="" found=0
  [ -f "$file" ] || return 1
  while IFS= read -r raw || [ -n "$raw" ]; do
    line="$(trim_shell_value "$raw")"
    [ -z "$line" ] && continue
    case "$line" in \#*) continue ;; esac
    case "$line" in export\ *) line="$(trim_shell_value "${line#export }")" ;; esac
    case "$line" in *=*) ;; *) continue ;; esac
    key="$(trim_shell_value "${line%%=*}")"
    [ "$key" = "$wanted" ] || continue
    value="$(trim_shell_value "${line#*=}")"
    if [[ "$value" =~ ^\"(.*)\"$ ]] || [[ "$value" =~ ^\'(.*)\'$ ]]; then
      value="${BASH_REMATCH[1]}"
    elif [[ "$value" = *[[:space:]]\#* ]]; then
      # %% removes the longest matching suffix, so this cuts at the FIRST
      # whitespace-# sequence, matching parseDotenv() rather than the last one.
      value="${value%%[[:space:]]\#*}"
      value="$(trim_shell_value "$value")"
    fi
    result="$value"
    found=1
  done < "$file"
  [ "$found" = 1 ] || return 1
  printf '%s' "$result"
}

resolve_ollama_url() {
  if [ "${OLLAMA_URL+x}" = x ]; then return 0; fi
  if OLLAMA_URL="$(repo_env_value OLLAMA_URL .env)"; then export OLLAMA_URL; return 0; fi
  OLLAMA_URL="http://localhost:11434"
  export OLLAMA_URL
}
```

Add the exact dependency-free validator:

```bash
ollama_url_fail() {
  OLLAMA_URL_RULE="$1"
  return 1
}

ollama_preflight_error() {
  printf 'OLLAMA_URL rejected (%s)' "$OLLAMA_URL_RULE"
}

ollama_preflight_fix() {
  printf '%s' 'set OLLAMA_URL=http://localhost:11434, then retry'
}

ollama_preparse_raw_path() {
  local raw_path="$1" segment="" index=0 char hex
  case "$raw_path" in *\\*) ollama_url_fail path_segment; return 1 ;; esac
  while [ "$index" -lt "${#raw_path}" ]; do
    char="${raw_path:index:1}"
    if [ "$char" = "%" ]; then
      hex="${raw_path:index+1:2}"
      if [[ "$hex" =~ ^[0-9A-Fa-f]{2}$ ]]; then
        case "$hex" in
          2[fF]|5[cC]) ollama_url_fail path_segment; return 1 ;;
          2[eE]) ollama_url_fail path_segment; return 1 ;;
        esac
      fi
    fi
    if [ "$char" = "/" ]; then
      [ "$segment" != "." ] && [ "$segment" != ".." ] ||
        { ollama_url_fail path_segment; return 1; }
      segment=""
    else
      segment="${segment}${char}"
    fi
    index=$((index + 1))
  done
  [ "$segment" != "." ] && [ "$segment" != ".." ] ||
    { ollama_url_fail path_segment; return 1; }
}

ollama_reject_non_printable_ascii() {
  local LC_ALL=C raw="$1" index=0 char byte
  while [ "$index" -lt "${#raw}" ]; do
    char="${raw:index:1}"
    printf -v byte '%d' "'$char"
    [ "$byte" -ge 33 ] && [ "$byte" -le 126 ] ||
      { ollama_url_fail endpoint_byte; return 1; }
    index=$((index + 1))
  done
}

validate_ollama_url() {
  local raw="$1" authority raw_host raw_port="" path="" hostname part
  local ipv6=0 had_trailing_dot=0 p1 p2 p3 p4 p5 port_value port_digits
  OLLAMA_URL_RULE=""
  [ -n "$raw" ] || { ollama_url_fail empty; return 1; }
  [[ "$raw" != *[[:cntrl:]]* ]] ||
    { ollama_url_fail control_character; return 1; }
  [ "$raw" = "$(trim_shell_value "$raw")" ] ||
    { ollama_url_fail surrounding_whitespace; return 1; }
  ollama_reject_non_printable_ascii "$raw" || return 1
  case "$raw" in *\?*|*\#*) ollama_url_fail query_or_fragment; return 1 ;; esac
  if [[ ! "$raw" =~ ^([A-Za-z][A-Za-z0-9+.-]*)://([^/?#]*)(/[^?#]*)?$ ]]; then
    ollama_url_fail syntax; return 1
  fi
  case "${BASH_REMATCH[1]}" in
    [Hh][Tt][Tt][Pp]) OLLAMA_SCHEME=http ;;
    [Hh][Tt][Tt][Pp][Ss]) OLLAMA_SCHEME=https ;;
    *) ollama_url_fail scheme; return 1 ;;
  esac
  authority="${BASH_REMATCH[2]}"
  path="${BASH_REMATCH[3]}"
  [ -n "$authority" ] || { ollama_url_fail syntax; return 1; }
  case "$authority" in *@*) ollama_url_fail credentials; return 1 ;; esac
  case "$authority" in *%*) ollama_url_fail authority_encoding; return 1 ;; esac
  ollama_preparse_raw_path "$path" || return 1

  if [[ "$authority" = \[* ]]; then
    if [[ "$authority" =~ ^\[([^]]+)\]$ ]]; then
      raw_host="${BASH_REMATCH[1]}"
      ipv6=1
    elif [[ "$authority" =~ ^\[([^]]+)\]:(.*)$ ]]; then
      raw_host="${BASH_REMATCH[1]}"
      raw_port="${BASH_REMATCH[2]}"
      ipv6=1
      [ -n "$raw_port" ] || { ollama_url_fail port; return 1; }
    else
      ollama_url_fail syntax; return 1
    fi
  else
    local colons="${authority//[^:]/}"
    [ "${#colons}" -le 1 ] || { ollama_url_fail syntax; return 1; }
    if [[ "$authority" = *:* ]]; then
      raw_host="${authority%:*}"
      raw_port="${authority##*:}"
      [ -n "$raw_port" ] || { ollama_url_fail port; return 1; }
    else
      raw_host="$authority"
    fi
  fi
  [ -n "$raw_host" ] || { ollama_url_fail syntax; return 1; }

  hostname="$raw_host"
  if [ "$ipv6" = 1 ] && [[ "$hostname" = *. ]]; then
    ollama_url_fail syntax; return 1
  fi
  if [[ "$hostname" = *. ]]; then
    had_trailing_dot=1
    hostname="${hostname%.}"
  fi
  [ -n "$hostname" ] && [[ "$hostname" != *. ]] ||
    { ollama_url_fail syntax; return 1; }
  if [ "$had_trailing_dot" = 1 ] && [ "$ipv6" = 0 ] &&
     ! [[ "$hostname" =~ ^[Ll][Oo][Cc][Aa][Ll][Hh][Oo][Ss][Tt]$ ]]; then
    ollama_url_fail syntax; return 1
  fi

  if [ "$ipv6" = 1 ]; then
    [[ "$hostname" =~ ^[0-9]+(\.[0-9]+){3}$ ]] &&
      { ollama_url_fail syntax; return 1; }
    [ "$hostname" = "::1" ] || { ollama_url_fail non_loopback_host; return 1; }
    OLLAMA_NORMALIZED_HOST="::1"
    OLLAMA_CONNECT_HOST="::1"
  elif [[ "$hostname" =~ ^[Ll][Oo][Cc][Aa][Ll][Hh][Oo][Ss][Tt]$ ]]; then
    OLLAMA_NORMALIZED_HOST="localhost"
    OLLAMA_CONNECT_HOST="127.0.0.1"
  else
    if [[ "$hostname" =~ ^[0-9]+$ ]] ||
       [[ "$hostname" =~ ^0[xX][0-9A-Fa-f]+$ ]]; then
      ollama_url_fail ambiguous_numeric_host; return 1
    fi
    [[ "$hostname" =~ ^[0-9.]+$ ]] ||
      { ollama_url_fail non_loopback_host; return 1; }
    IFS=. read -r p1 p2 p3 p4 p5 <<< "$hostname"
    [ -n "$p1" ] && [ -n "$p2" ] && [ -n "$p3" ] && [ -n "$p4" ] && [ -z "$p5" ] ||
      { ollama_url_fail ambiguous_numeric_host; return 1; }
    for part in "$p1" "$p2" "$p3" "$p4"; do
      [[ "$part" =~ ^(0|[1-9][0-9]{0,2})$ ]] ||
        { ollama_url_fail ambiguous_numeric_host; return 1; }
      [ "$((10#$part))" -le 255 ] ||
        { ollama_url_fail ambiguous_numeric_host; return 1; }
    done
    [ "$p1" = 127 ] || { ollama_url_fail non_loopback_host; return 1; }
    OLLAMA_NORMALIZED_HOST="$p1.$p2.$p3.$p4"
    OLLAMA_CONNECT_HOST="$OLLAMA_NORMALIZED_HOST"
  fi

  if [ -n "$raw_port" ]; then
    [[ "$raw_port" =~ ^[0-9]+$ ]] || { ollama_url_fail port; return 1; }
    port_digits="$raw_port"
    while [ "${#port_digits}" -gt 1 ] && [[ "$port_digits" = 0* ]]; do
      port_digits="${port_digits#0}"
    done
    [ "${#port_digits}" -le 5 ] || { ollama_url_fail port; return 1; }
    port_value=$((10#$port_digits))
    [ "$port_value" -ge 1 ] && [ "$port_value" -le 65535 ] ||
      { ollama_url_fail port; return 1; }
    OLLAMA_PORT="$port_value"
  elif [ "$OLLAMA_SCHEME" = http ]; then
    OLLAMA_PORT=80
  else
    OLLAMA_PORT=443
  fi

  while [ -n "$path" ] && [[ "$path" = */ ]]; do path="${path%/}"; done
  OLLAMA_BASE_PATH="$path"
  OLLAMA_HOST_HEADER="$authority"
  OLLAMA_CAN_LAUNCH=0
  if [ "$OLLAMA_SCHEME" = http ] && [ -z "$OLLAMA_BASE_PATH" ]; then
    OLLAMA_CAN_LAUNCH=1
  fi
  if [ "$OLLAMA_NORMALIZED_HOST" = "::1" ]; then
    OLLAMA_BIND_AUTHORITY="[::1]:$OLLAMA_PORT"
  else
    OLLAMA_BIND_AUTHORITY="$OLLAMA_CONNECT_HOST:$OLLAMA_PORT"
  fi
  return 0
}

ollama_preflight() {
  resolve_ollama_url
  validate_ollama_url "$OLLAMA_URL"
}
```

`ollama_reject_non_printable_ascii()` runs after shared dotenv trimming but before regex/path
parsing and uses a C-locale byte loop to accept only `0x21..0x7e`; it returns the fixed
`endpoint_byte` rule for literal internal spaces and all non-ASCII bytes. This mirrors
TypeScript's UTF-8 byte check. Percent-encoded `%20` and `%C3%A9` remain ASCII source bytes
and are accepted unchanged. `ollama_preparse_raw_path()` then runs before the trailing-slash
loop and mirrors TypeScript character-for-character: `/./`, `/../`, exact `/.` and `/..`,
nested variants, every raw `%2e` occurrence (including embedded and mixed-case forms), encoded
separators, and literal backslashes receive the same fixed `path_segment` rule; `v1.2`,
`model..name`, literal `a.b`, `%252e`, and `%255c` remain ordinary segments.

It uses Bash regex/parameter expansion only. `repo_env_value()` deliberately scans the whole
file and stores the last matching assignment, matching `parseDotenv()`; it never returns
from the first match. Its `%%[[:space:]]#*` cut selects the first unquoted whitespace-`#`
comment boundary even when the comment contains later ` #` sequences. No branch invokes
DNS, curl, Bun, Python, Perl, Ruby, Node, or `getent`.

Unless `MINIME_LIB_SKIP_RESOLVE=1`, finish library initialization with:

```bash
resolve_ollama_url
```

- [ ] **Step 6: Wire every pure preflight before effects**

At the first executable line of `src/cli.ts` `main()`:

```ts
const ollama = ollamaPreflight(config.ollamaUrl);
if (!ollama.ok) {
  console.error(ollama.error);
  console.error(ollama.fix);
  return ollama.exitCode;
}
```

Import `ollamaPreflight`; do not validate by throwing at module import.

At the first line of `ollamaProvider(fetchFn?)`, call:

```ts
const endpoint = validateOllamaUrl(config.ollamaUrl);
```

In `src/verify/m0.ts`, immediately after defining `check()` and before the first SQL query,
add:

```ts
const ollama = ollamaPreflight(config.ollamaUrl);
if (!ollama.ok) {
  check("ollama url valid", false, ollama.rule);
  await closeDb();
  process.exit(1);
}
const ollamaEndpoint = ollama.endpoint;
```

Use `ollamaEndpoint` later for tags. This prints only
`FAIL  ollama url valid — <rule>`, closes the still-lazy pool, and exits 1 without database
or network work.

In `scripts/install.sh`, after flag parsing and definition of `line()`/`die()` but before OS
detection, Bun, PATH changes, dependency probes, or service detection:

```bash
STEP=1
if ! ollama_preflight; then
  die 40 env "$(ollama_preflight_error)" "$(ollama_preflight_fix)"
fi
```

`ollama_preflight` itself prints nothing. `die` never includes the raw value.

In `scripts/up.sh`, place this immediately after sourcing `scripts/lib.sh`:

```bash
if ! ollama_preflight; then
  echo "ERROR: $(ollama_preflight_error)." >&2
  echo "FIX: $(ollama_preflight_fix)." >&2
  exit 40
fi
```

- [ ] **Step 7: Run the corpus/preflight tests green**

```bash
bun test test/h2.ollama-url.test.ts test/install.test.ts
```

Expected: shared corpus parity passes, including DEL (`0x7f`) and the exact
`URL # first # second` first-comment-boundary fixture; provider fails before injected HTTP;
invalid CLI migrate/audit exit 40 without DB/network/files; installer invalid env and `.env`
cases emit `[1/9] FAIL env` plus fixed final lines; valid `--no-ollama` dry run still exits 0.

- [ ] **Step 8: Commit URL validation and preflights**

```bash
git add fixtures/ollama-url-corpus.tsv src/util/ollama-url.ts src/cli.ts src/llm/ollama.ts \
  src/verify/m0.ts scripts/lib.sh scripts/install.sh scripts/up.sh \
  test/h2.ollama-url.test.ts test/install.test.ts
git commit -m "fix(ollama): reject non-loopback configuration"
```

### Task 2: Replace ambient runtime HTTP with direct pinned sockets

**Files:**
- Create: `src/llm/ollama-http.ts`
- Create: `test/h2.ollama-http.test.ts`
- Modify: `src/llm/ollama.ts`
- Modify: `src/verify/m0.ts`
- Modify: `test/providers.test.ts`

**Interfaces:**
- Consumes: validated `OllamaEndpoint`
- Produces: `ollamaRequest(endpoint, apiPath, init)`, direct generation/embedding/tags paths

- [ ] **Step 1: Write complete local HTTP tripwire fixtures**

Create `test/h2.ollama-http.test.ts`:

```ts
import { afterEach, expect, test } from "bun:test";
import {
  createServer,
  request as nodeRequest,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { LookupFunction } from "node:net";
import { ollamaProvider } from "../src/llm/ollama";
import {
  fetchOllamaTags,
  ollamaNodeRequestOptions,
  ollamaRequest,
} from "../src/llm/ollama-http";
import { config } from "../src/util/config";
import { validateOllamaUrl } from "../src/util/ollama-url";

interface SeenRequest {
  method: string;
  url: string;
  host: string;
  body: string;
}

const closers: Array<() => Promise<void>> = [];
const savedUrl = config.ollamaUrl;
const proxyKeys = [
  "HTTP_PROXY",
  "http_proxy",
  "HTTPS_PROXY",
  "https_proxy",
  "ALL_PROXY",
  "all_proxy",
] as const;
const savedProxy = new Map(proxyKeys.map((key) => [key, process.env[key]]));

afterEach(async () => {
  config.ollamaUrl = savedUrl;
  for (const key of proxyKeys) {
    const value = savedProxy.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await Promise.all(closers.splice(0).map((close) => close()));
});

async function fixture(
  respond: (request: SeenRequest, raw: IncomingMessage, response: ServerResponse) => void,
) {
  const seen: SeenRequest[] = [];
  let connections = 0;
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      const item = {
        method: request.method ?? "",
        url: request.url ?? "",
        host: request.headers.host ?? "",
        body: Buffer.concat(chunks).toString("utf8"),
      };
      seen.push(item);
      respond(item, request, response);
    });
  });
  server.on("connection", () => {
    connections += 1;
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("HTTP fixture did not bind");
  closers.push(() =>
    new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()),
    ),
  );
  return { port: address.port, seen, connections: () => connections };
}

function json(response: ServerResponse, value: unknown): void {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

test("generation and embedding use the direct base-path endpoint and original Host", async () => {
  const direct = await fixture((request, _raw, response) => {
    if (request.url === "/base/api/generate") json(response, { response: '{"ok":true}' });
    else if (request.url === "/base/api/embed") json(response, { embeddings: [[0.25]] });
    else response.writeHead(404).end();
  });
  config.ollamaUrl = `http://LOCALHOST.:${direct.port}/base/`;
  const provider = ollamaProvider();
  expect(await provider.completeJson("fictional prompt")).toBe('{"ok":true}');
  expect(await provider.embed!(["fictional text"])).toEqual([[0.25]]);
  expect(direct.seen.map((request) => request.url)).toEqual([
    "/base/api/generate",
    "/base/api/embed",
  ]);
  expect(direct.seen.every((request) => request.host === `LOCALHOST.:${direct.port}`)).toBe(true);
  expect(JSON.parse(direct.seen[0]!.body)).toMatchObject({
    prompt: "fictional prompt",
    stream: false,
  });
});

test.each([307, 308])(
  "status %d is terminal and the Location target receives zero requests",
  async (status) => {
    const target = await fixture((_request, _raw, response) => json(response, { reached: true }));
    const location = `http://127.0.0.1:${target.port}/leak-sentinel`;
    const direct = await fixture((_request, _raw, response) => {
      response.writeHead(status, { location });
      response.end("response-body-sentinel");
    });
    config.ollamaUrl = `http://127.0.0.1:${direct.port}`;
    let message = "";
    try {
      await ollamaProvider().completeJson("fictional prompt");
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain(`redirect_refused: ${status}`);
    expect(message).not.toContain(location);
    expect(message).not.toContain("response-body-sentinel");
    expect(target.seen).toHaveLength(0);
  },
);

test.each([
  { status: 307, operation: "embed" as const },
  { status: 308, operation: "embed" as const },
  { status: 307, operation: "tags" as const },
  { status: 308, operation: "tags" as const },
])("$operation status $status is fixed and never follows Location", async ({
  status,
  operation,
}) => {
  const target = await fixture((_request, _raw, response) =>
    json(response, { reached: true }),
  );
  const location = `http://127.0.0.1:${target.port}/leak-sentinel`;
  const direct = await fixture((_request, _raw, response) => {
    response.writeHead(status, { location });
    response.end("response-body-sentinel");
  });
  config.ollamaUrl = `http://127.0.0.1:${direct.port}`;
  let message = "";
  try {
    if (operation === "embed") {
      await ollamaProvider().embed!(["fictional text"]);
    } else {
      await fetchOllamaTags(validateOllamaUrl(config.ollamaUrl));
    }
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  expect(message).toBe(`ollama redirect_refused: ${status}`);
  expect(message).not.toContain(location);
  expect(message).not.toContain("response-body-sentinel");
  expect(direct.seen.map((request) => request.url)).toEqual([
    operation === "embed" ? "/api/embed" : "/api/tags",
  ]);
  expect(target.seen).toHaveLength(0);
});

test("all proxy environment variants are ignored", async () => {
  const proxy = await fixture((_request, _raw, response) => json(response, { proxy: true }));
  const direct = await fixture((request, _raw, response) => {
    if (request.url === "/api/generate")
      json(response, { response: '{"direct":true}' });
    else if (request.url === "/api/embed")
      json(response, { embeddings: [[0.75]] });
    else if (request.url === "/api/tags")
      json(response, { models: [{ name: "nomic-embed-text" }] });
    else response.writeHead(404).end();
  });
  for (const key of proxyKeys) process.env[key] = `http://127.0.0.1:${proxy.port}`;
  config.ollamaUrl = `http://localhost:${direct.port}`;
  const provider = ollamaProvider();
  expect(await provider.completeJson("fictional")).toBe('{"direct":true}');
  expect(await provider.embed!(["fictional text"])).toEqual([[0.75]]);
  expect(
    await fetchOllamaTags(validateOllamaUrl(config.ollamaUrl)),
  ).toEqual(["nomic-embed-text"]);
  expect(direct.seen.map((request) => request.url)).toEqual([
    "/api/generate",
    "/api/embed",
    "/api/tags",
  ]);
  expect(proxy.seen).toHaveLength(0);
});

test("request options pin localhost, preserve Host, and set normalized HTTPS SNI", () => {
  const endpoint = validateOllamaUrl("https://LOCALHOST.:9443/proxy");
  const options = ollamaNodeRequestOptions(endpoint, "/api/tags", { method: "GET" });
  expect(options.hostname).toBe("127.0.0.1");
  expect(options.port).toBe(9443);
  expect(options.path).toBe("/proxy/api/tags");
  expect(options.method).toBe("GET");
  expect(options.servername).toBe("localhost");
  expect(options.agent).toBe(false);
  expect(new Headers(options.headers as HeadersInit).get("host")).toBe("LOCALHOST.:9443");
});

test("an actual localhost request never invokes a hostile DNS or hosts resolver", async () => {
  const direct = await fixture((_request, _raw, response) => response.end("direct"));
  const endpoint = validateOllamaUrl(`http://localhost:${direct.port}`);
  let lookups = 0;
  const lookup = ((_hostname, _options, callback) => {
    lookups += 1;
    callback(new Error("fixture DNS lookup must not run"), "", 4);
  }) as LookupFunction;
  const body = await new Promise<string>((resolve, reject) => {
    const req = nodeRequest(
      { ...ollamaNodeRequestOptions(endpoint, "/api/tags"), lookup },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        response.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      },
    );
    req.on("error", reject);
    req.end();
  });
  expect(body).toBe("direct");
  expect(lookups).toBe(0);
  expect(direct.seen).toHaveLength(1);
});

test("side-effect-free tags helper uses the same direct transport", async () => {
  const direct = await fixture((_request, _raw, response) =>
    json(response, { models: [{ name: "nomic-embed-text" }, { name: "llama3.1:8b" }] }),
  );
  const endpoint = validateOllamaUrl(`http://localhost:${direct.port}`);
  expect(await fetchOllamaTags(endpoint, { timeoutMs: 3_000 })).toEqual([
    "nomic-embed-text",
    "llama3.1:8b",
  ]);
  expect(direct.seen.map((request) => request.url)).toEqual(["/api/tags"]);
});

test("wall-clock deadline rejects a trickle response that never goes idle", async () => {
  const trickle = await fixture((_request, _raw, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    const interval = setInterval(() => response.write(" "), 5);
    response.on("close", () => clearInterval(interval));
  });
  const endpoint = validateOllamaUrl(`http://127.0.0.1:${trickle.port}`);
  const started = performance.now();
  await expect(
    ollamaRequest(endpoint, "/api/tags", {}, { timeoutMs: 40 }),
  ).rejects.toThrow(/deadline/);
  expect(performance.now() - started).toBeLessThan(500);
});

test.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1.5])(
  "invalid timeout %p fails before opening a socket",
  async (timeoutMs) => {
    const direct = await fixture((_request, _raw, response) => response.end("{}"));
    const endpoint = validateOllamaUrl(`http://127.0.0.1:${direct.port}`);
    await expect(
      ollamaRequest(endpoint, "/api/tags", {}, { timeoutMs }),
    ).rejects.toThrow(/positive integer/);
    await Bun.sleep(20);
    expect(direct.connections()).toBe(0);
  },
);

test("an already-aborted signal opens zero sockets and never writes or ends", async () => {
  const direct = await fixture((_request, _raw, response) => response.end("{}"));
  const endpoint = validateOllamaUrl(`http://127.0.0.1:${direct.port}`);
  const controller = new AbortController();
  controller.abort();
  await expect(
    ollamaRequest(
      endpoint,
      "/api/generate",
      { method: "POST", body: '{"fictional":true}', signal: controller.signal },
      { timeoutMs: 5_000 },
    ),
  ).rejects.toThrow(/abort/i);
  await Bun.sleep(20);
  expect(direct.connections()).toBe(0);
  expect(direct.seen).toHaveLength(0);
});

test("in-flight caller abort and response-stream failure reject cleanly", async () => {
  const hanging = await fixture((_request, _raw, _response) => {});
  const endpoint = validateOllamaUrl(`http://127.0.0.1:${hanging.port}`);
  const controller = new AbortController();
  const pending = ollamaRequest(
    endpoint,
    "/api/tags",
    { signal: controller.signal },
    { timeoutMs: 5_000 },
  );
  controller.abort();
  await expect(pending).rejects.toThrow(/abort/i);

  const broken = await fixture((_request, _raw, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.write('{"models":[');
    response.socket?.destroy(new Error("fixture stream failure"));
  });
  await expect(
    fetchOllamaTags(validateOllamaUrl(`http://127.0.0.1:${broken.port}`)),
  ).rejects.toThrow();
});
```

Every listener binds only to `127.0.0.1`; `afterEach` restores configuration/proxy state and
closes every listener.

- [ ] **Step 2: Run the runtime HTTP tests red**

```bash
bun test test/h2.ollama-http.test.ts test/providers.test.ts
```

Expected: FAIL because production defaults use ambient `fetch`, redirects are fetch-policy
dependent, localhost is not explicitly pinned, and verifier uses global fetch. Existing
injected request-shape tests remain green and are not the red signal.

- [ ] **Step 3: Implement the direct request helper**

Create `src/llm/ollama-http.ts` with:

```ts
import * as http from "node:http";
import * as https from "node:https";
import type { OllamaEndpoint } from "../util/ollama-url";

export interface OllamaRequestOptions {
  timeoutMs?: number;
}

function requestBody(init: RequestInit | undefined): Buffer | undefined {
  if (init?.body === undefined || init.body === null) return undefined;
  if (typeof init.body !== "string") {
    throw new Error("ollama direct request body must be a string");
  }
  return Buffer.from(init.body, "utf8");
}

export function ollamaNodeRequestOptions(
  endpoint: OllamaEndpoint,
  apiPath: `/${string}`,
  init: RequestInit = {},
): http.RequestOptions {
  const body = requestBody(init);
  const headers = new Headers(init.headers);
  headers.set("host", endpoint.hostHeader);
  if (body) headers.set("content-length", String(body.byteLength));
  return {
    protocol: endpoint.protocol,
    hostname: endpoint.connectHost,
    port: endpoint.port,
    path: `${endpoint.basePath}${apiPath}`,
    method: init.method ?? "GET",
    headers: Object.fromEntries(headers.entries()),
    agent: false,
    ...(endpoint.protocol === "https:" ? { servername: endpoint.serverName } : {}),
  };
}

export async function ollamaRequest(
  endpoint: OllamaEndpoint,
  apiPath: `/${string}`,
  init: RequestInit = {},
  options: OllamaRequestOptions = {},
): Promise<Response> {
  const body = requestBody(init);
  const transport = endpoint.protocol === "https:" ? https : http;
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError("ollama timeoutMs must be a positive integer");
  }
  if (init.signal?.aborted) {
    throw new Error("ollama request aborted");
  }
  return await new Promise<Response>((resolve, reject) => {
    let settled = false;
    let req: http.ClientRequest | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: Error, response?: Response) => {
      if (settled) return;
      settled = true;
      if (deadline) clearTimeout(deadline);
      init.signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve(response!);
    };
    const onAbort = () => {
      const error = new Error("ollama request aborted");
      req?.destroy(error);
      finish(error);
    };
    init.signal?.addEventListener("abort", onAbort, { once: true });
    if (init.signal?.aborted) {
      onAbort();
      return;
    }
    deadline = setTimeout(() => {
      const error = new Error("ollama request deadline exceeded");
      req?.destroy(error);
      finish(error);
    }, timeoutMs);
    try {
      req = transport.request(
        ollamaNodeRequestOptions(endpoint, apiPath, init),
        (res) => {
          const status = res.statusCode;
          if (status === undefined) {
            res.destroy();
            finish(new Error("ollama response missing status"));
            return;
          }
          if (status >= 300 && status < 400) {
            res.destroy();
            finish(new Error(`ollama redirect_refused: ${status}`));
            return;
          }
          const chunks: Buffer[] = [];
          res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
          res.on("error", (error) => finish(error));
          res.on("aborted", () => finish(new Error("ollama response aborted")));
          res.on("end", () => {
            const responseHeaders = new Headers();
            for (const [name, value] of Object.entries(res.headers)) {
              if (value !== undefined)
                responseHeaders.set(name, Array.isArray(value) ? value.join(", ") : value);
            }
            finish(
              undefined,
              new Response(Buffer.concat(chunks), {
                status,
                statusText: res.statusMessage,
                headers: responseHeaders,
              }),
            );
          });
        },
      );
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    const active = req;
    if (!active) {
      finish(new Error("ollama request was not created"));
      return;
    }
    active.on("error", (error) => finish(error));
    if (settled || init.signal?.aborted) {
      active.destroy(new Error("ollama request aborted"));
      return;
    }
    if (body && !settled) active.write(body);
    if (!settled) active.end();
  });
}

export async function fetchOllamaTags(
  endpoint: OllamaEndpoint,
  options: OllamaRequestOptions = {},
): Promise<string[]> {
  const response = await ollamaRequest(endpoint, "/api/tags", { method: "GET" }, options);
  if (!response.ok) throw new Error(`ollama tags failed: ${response.status}`);
  const body = (await response.json()) as { models?: { name?: string }[] };
  return (body.models ?? []).flatMap((model) =>
    typeof model.name === "string" ? [model.name] : [],
  );
}
```

The deadline timer measures total elapsed time, not socket idleness, and is cleared on every
settlement. Invalid timeouts and already-aborted signals reject before
`transport.request()`; the second abort check closes the listener-registration race, and no
branch calls `write()`/`end()` after settlement. Node's direct
`http.request`/`https.request` does not consult proxy environment variables. `hostname` is
the validated/pinned numeric socket target, so an actual request configured as `localhost`
reaches the `127.0.0.1` fixture without consulting DNS or `/etc/hosts`; `Host` remains the
configured authority and HTTPS `servername` is normalized `localhost`.

- [ ] **Step 4: Use the direct helper by default while preserving injected tests**

In `src/llm/ollama.ts`, remove the ambient `= fetch` default:

```ts
export function ollamaProvider(fetchFn?: FetchFn): LlmProvider {
```

After construction validation, define:

```ts
const request = async (
  apiPath: `/${string}`,
  init?: RequestInit,
): Promise<Response> => {
  if (fetchFn) return fetchFn(ollamaApiUrl(endpoint, apiPath), init);
  return ollamaRequest(endpoint, apiPath, init);
};
```

Change embed/generate to `request("/api/embed", ...)` and
`request("/api/generate", ...)`. Remove response-body text from errors:

```ts
if (!res.ok) throw new Error(`ollama embed failed: ${res.status}`);
```

Keep request JSON, batching, model fields, format, stream, and temperature unchanged.

Import `fetchOllamaTags` into `src/verify/m0.ts` from the side-effect-free
`src/llm/ollama-http.ts` module. Use the already validated endpoint and preserve the current
three-second verifier probe:

```ts
const names = await fetchOllamaTags(endpoint, { timeoutMs: 3_000 });
```

Do not export a helper from, or import, top-level `src/verify/m0.ts`: that file executes SQL
and calls `process.exit`. Do not call `fetch`.

- [ ] **Step 5: Preserve existing injected provider contracts**

Update `test/providers.test.ts` only where construction now validates first. Keep the
`fakeFetch` injection and exact `/api/embed`/`/api/generate` JSON assertions. Add:

```ts
test("injected local Ollama still produces zero cloud-egress rows", async () => {
  const before = await sql`select count(*)::int n from events where verb like 'egress:%'`;
  const { fn } = fakeFetch((capture) =>
    capture.url.endsWith("/api/embed")
      ? { embeddings: capture.body.input.map(() => [0.1]) }
      : { response: '{"ok":true}' },
  );
  const provider = ollamaProvider(fn);
  await provider.completeJson("fictional local prompt");
  await provider.embed!(["fictional local text"]);
  const after = await sql`select count(*)::int n from events where verb like 'egress:%'`;
  expect(after[0]!.n).toBe(before[0]!.n);
});
```

The test asserts no `egress:*` row and never invokes the direct network helper.

- [ ] **Step 6: Run runtime provider tests**

```bash
bun test test/h2.ollama-http.test.ts test/providers.test.ts test/m13.provider-routing.test.ts
```

Expected: PASS; redirect/proxy/DNS tripwires receive zero requests; direct fixture sees
generation, embedding, and tags; the trickle response is stopped by a true wall-clock
deadline; invalid timeouts/already-aborted signals open zero sockets; existing request shapes
and local zero-egress behavior remain green.

- [ ] **Step 7: Commit direct runtime I/O**

```bash
git add src/llm/ollama-http.ts src/llm/ollama.ts src/verify/m0.ts \
  test/h2.ollama-http.test.ts test/providers.test.ts
git commit -m "fix(ollama): pin runtime requests to direct sockets"
```

### Task 3: Harden shell tags, pulls, and server launch

**Files:**
- Modify: `scripts/lib.sh`
- Modify: `scripts/install.sh`
- Modify: `scripts/up.sh`
- Create: `test/h2.ollama-shell.test.ts`
- Modify: `test/install.test.ts`

**Interfaces:**
- Consumes: shell normalized globals
- Produces: 2xx-only hardened curl, HTTP pull, safe explicit bind, zero Ollama network work under `--no-ollama`

- [ ] **Step 1: Write the complete shell tripwire harness**

Create `test/h2.ollama-shell.test.ts`. Reuse the TSV `corpus()` reader from Task 1 and add
the following runnable helpers (all fixture content is fictional):

```ts
import { afterEach, expect, test } from "bun:test";
import { createServer, type ServerResponse } from "node:http";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO = resolve(import.meta.dir, "..");
const REAL_CURL = Bun.which("curl");
if (!REAL_CURL) throw new Error("curl is required for H2 shell fixtures");
const roots: string[] = [];
const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function executable(path: string, body: string): void {
  writeFileSync(path, `#!/bin/bash\nset -eu\n${body}\n`, { mode: 0o700 });
  chmodSync(path, 0o700);
}

function copiedScripts() {
  const root = mkdtempSync(join(tmpdir(), "minime-h2-shell-"));
  roots.push(root);
  const scripts = join(root, "scripts");
  const bin = join(root, "bin");
  const trace = join(root, "trace");
  mkdirSync(scripts, { mode: 0o700 });
  mkdirSync(bin, { mode: 0o700 });
  mkdirSync(join(root, "node_modules", "postgres"), { recursive: true });
  writeFileSync(trace, "", { mode: 0o600 });
  writeFileSync(join(root, ".env.example"), "# fictional fixture\n", { mode: 0o600 });
  for (const name of ["lib.sh", "install.sh", "up.sh"]) {
    const target = join(scripts, name);
    writeFileSync(target, readFileSync(join(REPO, "scripts", name)), { mode: 0o700 });
    chmodSync(target, 0o700);
  }
  for (const name of ["docker", "brew", "curl", "pg_isready", "psql"]) {
    executable(join(bin, name), `printf '%s %s\\n' ${JSON.stringify(name)} "$*" >> "$H2_TRACE"; exit 91`);
  }
  return { root, scripts, bin, trace };
}

async function run(
  argv: string[],
  cwd: string,
  env: Record<string, string | undefined>,
) {
  const clean = Object.fromEntries(
    Object.entries({ ...process.env, ...env }).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  const proc = Bun.spawn(argv, {
    cwd,
    env: clean,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, out, err };
}

async function httpFixture(
  responder: (request: { method: string; url: string; host: string; body: string },
    response: ServerResponse) => void,
) {
  const seen: Array<{ method: string; url: string; host: string; body: string }> = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      const item = {
        method: request.method ?? "",
        url: request.url ?? "",
        host: request.headers.host ?? "",
        body: Buffer.concat(chunks).toString("utf8"),
      };
      seen.push(item);
      responder(item, response);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("shell fixture did not bind");
  closers.push(() =>
    new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()),
    ),
  );
  return { port: address.port, seen };
}

async function libCall(
  lib: string,
  shell: string,
  env: Record<string, string | undefined>,
) {
  return run(["bash", "-c", '. "$1"; eval "$2"', "_", lib, shell], REPO, {
    MINIME_LIB_SKIP_RESOLVE: "1",
    ...env,
  });
}
```

Add the complete preflight-order cases:

```ts
test.each(["install.sh", "up.sh"])(
  "%s rejects exported configuration before every executable sentinel",
  async (name) => {
    const f = copiedScripts();
    const invalid = "http://user:fictional-secret@198.51.100.8:11434";
    const args = name === "install.sh" ? ["--dry-run"] : [];
    const result = await run(["bash", join(f.scripts, name), ...args], f.root, {
      PATH: `${f.bin}:/usr/bin:/bin`,
      H2_TRACE: f.trace,
      OLLAMA_URL: invalid,
    });
    expect(result.code).toBe(40);
    expect(`${result.out}\n${result.err}`).not.toContain(invalid);
    expect(`${result.out}\n${result.err}`).not.toContain("fictional-secret");
    if (name === "install.sh") {
      expect(result.out).toMatch(/^\[1\/9\] FAIL +env: OLLAMA_URL rejected \(credentials\)$/m);
      expect(`${result.out}\n${result.err}`).toContain("ERROR:");
      expect(`${result.out}\n${result.err}`).toContain("FIX:");
    }
    expect(readFileSync(f.trace, "utf8")).toBe("");
    expect(readdirSync(f.root).sort()).toEqual(
      [".env.example", "bin", "node_modules", "scripts", "trace"].sort(),
    );
  },
);

test.each(["install.sh", "up.sh"])(
  "%s safely reads invalid fixture .env and rejects before sentinels",
  async (name) => {
    const f = copiedScripts();
    const invalid = "http://192.168.10.20:11434";
    writeFileSync(join(f.root, ".env"), `OLLAMA_URL=${invalid}\n`, { mode: 0o600 });
    const result = await run(
      ["bash", join(f.scripts, name), ...(name === "install.sh" ? ["--dry-run"] : [])],
      f.root,
      {
        PATH: `${f.bin}:/usr/bin:/bin`,
        H2_TRACE: f.trace,
        OLLAMA_URL: undefined,
      },
    );
    expect(result.code).toBe(40);
    expect(`${result.out}\n${result.err}`).not.toContain(invalid);
    expect(readFileSync(f.trace, "utf8")).toBe("");
  },
);

test.each(["install.sh", "up.sh"])(
  "%s uses the last duplicate .env assignment before any side effect",
  async (name) => {
    const f = copiedScripts();
    writeFileSync(
      join(f.root, ".env"),
      "OLLAMA_URL=http://localhost:11434\n" +
        "OLLAMA_URL=http://192.168.10.20:11434\n",
      { mode: 0o600 },
    );
    const result = await run(
      ["bash", join(f.scripts, name), ...(name === "install.sh" ? ["--dry-run"] : [])],
      f.root,
      {
        PATH: `${f.bin}:/usr/bin:/bin`,
        H2_TRACE: f.trace,
        OLLAMA_URL: undefined,
      },
    );
    expect(result.code).toBe(40);
    expect(readFileSync(f.trace, "utf8")).toBe("");
    expect(`${result.out}\n${result.err}`).not.toContain("192.168.10.20");
  },
);

test("inverse duplicate .env order accepts the final loopback value", async () => {
  const f = copiedScripts();
  writeFileSync(
    join(f.root, ".env"),
    "OLLAMA_URL=http://192.168.10.20:11434\n" +
      "OLLAMA_URL=http://localhost:11434\n",
    { mode: 0o600 },
  );
  const result = await run(
    ["bash", join(f.scripts, "install.sh"), "--dry-run", "--no-ollama"],
    f.root,
    {
      PATH: `${f.bin}:/usr/bin:/bin`,
      H2_TRACE: f.trace,
      OLLAMA_URL: undefined,
    },
  );
  expect(result.code, `${result.out}\n${result.err}`).toBe(0);
  expect(readFileSync(f.trace, "utf8")).toBe("");
});

test("invalid fresh-machine dry run does not require Bun", async () => {
  const f = copiedScripts();
  rmSync(join(f.bin, "bun"), { force: true });
  const result = await run(["bash", join(f.scripts, "install.sh"), "--dry-run"], f.root, {
    PATH: `${f.bin}:/usr/bin:/bin`,
    H2_TRACE: f.trace,
    OLLAMA_URL: "http://2130706433:11434",
  });
  expect(result.code).toBe(40);
  expect(readFileSync(f.trace, "utf8")).toBe("");
});

test("--no-ollama performs no request, but does not bypass invalid preflight", async () => {
  const f = copiedScripts();
  const direct = await httpFixture((_request, response) => response.end("{}"));
  const proxy = await httpFixture((_request, response) => response.end("{}"));
  const valid = await run(
    ["bash", join(f.scripts, "install.sh"), "--dry-run", "--no-ollama"],
    f.root,
    {
      PATH: `${f.bin}:/usr/bin:/bin`,
      H2_TRACE: f.trace,
      OLLAMA_URL: `http://127.0.0.1:${direct.port}`,
      HTTP_PROXY: `http://127.0.0.1:${proxy.port}`,
      http_proxy: `http://127.0.0.1:${proxy.port}`,
    },
  );
  expect(valid.code).toBe(0);
  expect(readFileSync(f.trace, "utf8")).toBe("");
  expect(direct.seen).toHaveLength(0);
  expect(proxy.seen).toHaveLength(0);
  const defaults = await run(
    ["bash", join(f.scripts, "install.sh"), "--dry-run", "--no-ollama"],
    f.root,
    {
      PATH: `${f.bin}:/usr/bin:/bin`,
      H2_TRACE: f.trace,
      OLLAMA_URL: undefined,
    },
  );
  expect(defaults.code).toBe(0);
  expect(readFileSync(f.trace, "utf8")).toBe("");
  const invalid = await run(
    ["bash", join(f.scripts, "install.sh"), "--dry-run", "--no-ollama"],
    f.root,
    {
      PATH: `${f.bin}:/usr/bin:/bin`,
      H2_TRACE: f.trace,
      OLLAMA_URL: "http://8.8.8.8:11434",
    },
  );
  expect(invalid.code).toBe(40);
});
```

Add the complete curl/redirect/pull cases:

```ts
test("tags/model/pull are direct, proxy-free, curlrc-free, Host-preserving, and private", async () => {
  const direct = await httpFixture((request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      request.url.endsWith("/api/tags")
        ? '{"models":[{"name":"nomic-embed-text:latest"}]}'
        : '{"status":"success"}',
    );
  });
  const proxy = await httpFixture((_request, response) => response.end("proxy"));
  const curlHome = mkdtempSync(join(tmpdir(), "minime-h2-curl-home-"));
  const tempRoot = mkdtempSync(join(tmpdir(), "minime-h2-curl-tmp-"));
  roots.push(curlHome, tempRoot);
  const fakeBin = join(curlHome, "bin");
  const curlTrace = join(curlHome, "curl-trace");
  const hostAliases = join(curlHome, "hostaliases");
  mkdirSync(fakeBin, { mode: 0o700 });
  writeFileSync(curlTrace, "", { mode: 0o600 });
  writeFileSync(hostAliases, "localhost hostile.invalid\n", { mode: 0o600 });
  executable(
    join(fakeBin, "curl"),
    'printf "curl %s\\n" "$*" >> "$H2_CURL_TRACE"; exec "$H2_REAL_CURL" "$@"',
  );
  writeFileSync(
    join(curlHome, ".curlrc"),
    "location\nconnect-to = \"localhost::127.0.0.1:9\"\n",
  );
  const env = {
    OLLAMA_URL: `http://LOCALHOST.:${direct.port}/base`,
    CURL_HOME: curlHome,
    TMPDIR: tempRoot,
    PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
    H2_REAL_CURL: REAL_CURL,
    H2_CURL_TRACE: curlTrace,
    HOSTALIASES: hostAliases,
    LOCALDOMAIN: "hostile.invalid",
    RES_OPTIONS: "attempts:0",
    HTTP_PROXY: `http://127.0.0.1:${proxy.port}`,
    http_proxy: `http://127.0.0.1:${proxy.port}`,
    HTTPS_PROXY: `http://127.0.0.1:${proxy.port}`,
    https_proxy: `http://127.0.0.1:${proxy.port}`,
    ALL_PROXY: `http://127.0.0.1:${proxy.port}`,
    all_proxy: `http://127.0.0.1:${proxy.port}`,
  };
  const lib = join(REPO, "scripts/lib.sh");
  for (const call of [
    "ollama_preflight && ollama_reachable",
    "ollama_preflight && ollama_has_model nomic-embed-text",
    "ollama_preflight && ollama_pull_model nomic-embed-text 3",
  ]) {
    const result = await libCall(lib, call, env);
    expect(result.code, `${result.out}\n${result.err}`).toBe(0);
    expect(readdirSync(tempRoot)).toEqual([]);
  }
  expect(direct.seen.map((request) => `${request.method} ${request.url}`)).toEqual([
    "GET /base/api/tags",
    "GET /base/api/tags",
    "POST /base/api/pull",
  ]);
  expect(direct.seen.every((request) => request.host === `LOCALHOST.:${direct.port}`)).toBe(true);
  expect(JSON.parse(direct.seen[2]!.body)).toEqual({
    name: "nomic-embed-text",
    stream: false,
  });
  const curlLines = readFileSync(curlTrace, "utf8").trim().split("\n");
  expect(
    curlLines.filter((line) =>
      line.includes(`--resolve localhost:${direct.port}:127.0.0.1`),
    ),
  ).toHaveLength(3);
  expect(
    curlLines.every((line) => line.includes(`--header Host: LOCALHOST.:${direct.port}`)),
  ).toBe(true);
  expect(proxy.seen).toHaveLength(0);
});

test("hostile curl stdout/stderr never escape tags/model/pull callers", async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "minime-h2-curl-hostile-"));
  roots.push(tempRoot);
  const fakeBin = join(tempRoot, "bin");
  mkdirSync(fakeBin, { mode: 0o700 });
  const stdoutSentinel = "H2_CURL_STDOUT_URL_HOST_PATH_SENTINEL";
  const stderrSentinel = "H2_CURL_STDERR_URL_HOST_PATH_SENTINEL";
  executable(
    join(fakeBin, "curl"),
    `printf '%s\\n' ${JSON.stringify(stdoutSentinel)}
printf '%s\\n' ${JSON.stringify(stderrSentinel)} >&2
exit 77`,
  );
  for (const call of [
    "ollama_preflight && ollama_reachable",
    "ollama_preflight && ollama_has_model nomic-embed-text",
    "ollama_preflight && ollama_pull_model nomic-embed-text 3",
  ]) {
    const result = await libCall(join(REPO, "scripts/lib.sh"), call, {
      OLLAMA_URL: "http://LOCALHOST.:11434/base",
      TMPDIR: tempRoot,
      PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
    });
    expect(result.code).not.toBe(0);
    expect(`${result.out}\\n${result.err}`).not.toContain(stdoutSentinel);
    expect(`${result.out}\\n${result.err}`).not.toContain(stderrSentinel);
  }
  expect(readdirSync(tempRoot)).toEqual(["bin"]);
});

test.each([307, 308])(
  "shell status %d never reaches redirect Location for tags or pull",
  async (status) => {
    const target = await httpFixture((_request, response) => response.end("target"));
    const direct = await httpFixture((_request, response) => {
      response.writeHead(status, {
        location: `http://127.0.0.1:${target.port}/response-sentinel`,
      });
      response.end("body-sentinel");
    });
    const lib = join(REPO, "scripts/lib.sh");
    for (const call of [
      "ollama_preflight && ollama_reachable",
      "ollama_preflight && ollama_pull_model nomic-embed-text 3",
    ]) {
      const result = await libCall(lib, call, {
        OLLAMA_URL: `http://localhost:${direct.port}`,
      });
      expect(result.code).not.toBe(0);
      expect(`${result.out}\n${result.err}`).not.toContain("body-sentinel");
      expect(`${result.out}\n${result.err}`).not.toContain("response-sentinel");
    }
    expect(target.seen).toHaveLength(0);
  },
);

test("invalid model bytes are rejected before JSON construction or requests", async () => {
  const direct = await httpFixture((_request, response) => response.end("{}"));
  const result = await libCall(
    join(REPO, "scripts/lib.sh"),
    `ollama_preflight && ollama_pull_model 'bad"name' 3`,
    { OLLAMA_URL: `http://127.0.0.1:${direct.port}` },
  );
  expect(result.code).not.toBe(0);
  expect(direct.seen).toHaveLength(0);
});

test("timeout and TERM clean private response workspaces", async () => {
  const hanging = await httpFixture((_request, _response) => {});
  const tempRoot = mkdtempSync(join(tmpdir(), "minime-h2-curl-timeout-"));
  roots.push(tempRoot);
  const timed = await libCall(
    join(REPO, "scripts/lib.sh"),
    "ollama_preflight && MINIME_OLLAMA_CURL_TIMEOUT=1 ollama_reachable",
    { OLLAMA_URL: `http://127.0.0.1:${hanging.port}`, TMPDIR: tempRoot },
  );
  expect(timed.code).not.toBe(0);
  expect(readdirSync(tempRoot)).toEqual([]);

  const fakeBin = join(tempRoot, "bin");
  mkdirSync(fakeBin);
  executable(join(fakeBin, "curl"), 'kill -TERM "$PPID"; exit 143');
  const signaled = await libCall(
    join(REPO, "scripts/lib.sh"),
    "ollama_preflight && ollama_reachable",
    {
      OLLAMA_URL: "http://127.0.0.1:11434",
      TMPDIR: tempRoot,
      PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
    },
  );
  expect(signaled.code).toBe(143);
  expect(readdirSync(tempRoot)).toEqual(["bin"]);
});

test("chmod failure is fail-closed and the installed EXIT trap cleans the workspace", async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "minime-h2-curl-chmod-"));
  roots.push(tempRoot);
  const fakeBin = join(tempRoot, "bin");
  mkdirSync(fakeBin);
  executable(join(fakeBin, "chmod"), "exit 73");
  const result = await libCall(
    join(REPO, "scripts/lib.sh"),
    "ollama_preflight && ollama_reachable",
    {
      OLLAMA_URL: "http://127.0.0.1:11434",
      TMPDIR: tempRoot,
      PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
    },
  );
  expect(result.code).not.toBe(0);
  expect(readdirSync(tempRoot)).toEqual(["bin"]);
});
```

Add an actual successful `up.sh` path and a redirecting `up.sh` path. These tests run the
whole copied script (including its PostgreSQL branch), not a source-only helper:

```ts
function makeUpFixtureCommands(f: ReturnType<typeof copiedScripts>): void {
  executable(
    join(f.bin, "docker"),
    `printf 'docker %s\n' "$*" >> "$H2_TRACE"
case "$*" in
  *"select 1 from pg_database"*) printf '1\n' ;;
esac
exit 0`,
  );
  executable(join(f.bin, "curl"), 'exec "$H2_REAL_CURL" "$@"');
}

test("valid up.sh uses hardened tags with pinned Host and ignores proxy/curlrc/OLLAMA_HOST", async () => {
  const f = copiedScripts();
  makeUpFixtureCommands(f);
  const direct = await httpFixture((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      '{"models":[{"name":"nomic-embed-text:latest"},{"name":"llama3.1:8b"}]}',
    );
  });
  const proxy = await httpFixture((_request, response) => response.end("proxy-sentinel"));
  const curlHome = mkdtempSync(join(tmpdir(), "minime-h2-up-curl-home-"));
  const tempRoot = mkdtempSync(join(tmpdir(), "minime-h2-up-tmp-"));
  roots.push(curlHome, tempRoot);
  writeFileSync(
    join(curlHome, ".curlrc"),
    "location\nconnect-to = \"localhost::127.0.0.1:9\"\n",
  );
  const result = await run(["bash", join(f.scripts, "up.sh")], f.root, {
    PATH: `${f.bin}:/usr/bin:/bin`,
    H2_TRACE: f.trace,
    H2_REAL_CURL: REAL_CURL,
    TMPDIR: tempRoot,
    CURL_HOME: curlHome,
    OLLAMA_URL: `http://LOCALHOST.:${direct.port}/base`,
    OLLAMA_HOST: "198.51.100.9:7777",
    HTTP_PROXY: `http://127.0.0.1:${proxy.port}`,
    http_proxy: `http://127.0.0.1:${proxy.port}`,
    HTTPS_PROXY: `http://127.0.0.1:${proxy.port}`,
    https_proxy: `http://127.0.0.1:${proxy.port}`,
    ALL_PROXY: `http://127.0.0.1:${proxy.port}`,
    all_proxy: `http://127.0.0.1:${proxy.port}`,
  });
  expect(result.code, `${result.out}\n${result.err}`).toBe(0);
  expect(result.out).toContain("==> up complete");
  expect(direct.seen.map((request) => request.url)).toEqual([
    "/base/api/tags",
    "/base/api/tags",
    "/base/api/tags",
  ]);
  expect(
    direct.seen.every((request) => request.host === `LOCALHOST.:${direct.port}`),
  ).toBe(true);
  expect(proxy.seen).toHaveLength(0);
  expect(`${result.out}\n${result.err}\n${readFileSync(f.trace, "utf8")}`).not.toContain(
    "198.51.100.9",
  );
  expect(readdirSync(tempRoot)).toEqual([]);
});

test.each([307, 308])(
  "valid up.sh treats status %d as terminal and never reaches Location",
  async (status) => {
    const f = copiedScripts();
    makeUpFixtureCommands(f);
    const target = await httpFixture((_request, response) =>
      response.end("target-sentinel"),
    );
    const direct = await httpFixture((_request, response) => {
      response.writeHead(status, {
        location: `http://127.0.0.1:${target.port}/redirect-sentinel`,
      });
      response.end("body-sentinel");
    });
    const proxy = await httpFixture((_request, response) =>
      response.end("proxy-sentinel"),
    );
    const tempRoot = mkdtempSync(join(tmpdir(), "minime-h2-up-redirect-"));
    roots.push(tempRoot);
    const result = await run(["bash", join(f.scripts, "up.sh")], f.root, {
      PATH: `${f.bin}:/usr/bin:/bin`,
      H2_TRACE: f.trace,
      H2_REAL_CURL: REAL_CURL,
      TMPDIR: tempRoot,
      OLLAMA_URL: `http://localhost:${direct.port}`,
      OLLAMA_HOST: "198.51.100.9:7777",
      HTTP_PROXY: `http://127.0.0.1:${proxy.port}`,
      ALL_PROXY: `http://127.0.0.1:${proxy.port}`,
    });
    expect(result.code, `${result.out}\n${result.err}`).toBe(0);
    expect(result.err).toContain("Ollama not reachable");
    expect(`${result.out}\n${result.err}`).not.toContain("body-sentinel");
    expect(`${result.out}\n${result.err}`).not.toContain("redirect-sentinel");
    expect(direct.seen).toHaveLength(1);
    expect(direct.seen[0]!.host).toBe(`localhost:${direct.port}`);
    expect(target.seen).toHaveLength(0);
    expect(proxy.seen).toHaveLength(0);
    expect(readdirSync(tempRoot)).toEqual([]);
  },
);
```

Add a complete valid-config installer redirect/proxy tripwire. It runs all nine copied
installer steps, with only PostgreSQL/Bun/Ollama executables faked; curl is the real binary
against loopback fixtures:

```ts
function makeInstallerFixtureCommands(f: ReturnType<typeof copiedScripts>): void {
  executable(
    join(f.bin, "bun"),
    `printf 'bun %s\n' "$*" >> "$H2_TRACE"
if [ "\${1:-}" = "--version" ]; then printf '1.2.0\n'; exit 0; fi
case "$*" in
  *src/cli.ts*) printf '{"ok":true}\n' ;;
esac
exit 0`,
  );
  executable(
    join(f.bin, "ollama"),
    'printf "ollama %s host=%s\\n" "$*" "${OLLAMA_HOST:-unset}" >> "$H2_TRACE"; exit 0',
  );
  executable(join(f.bin, "curl"), 'exec "$H2_REAL_CURL" "$@"');
  executable(join(f.bin, "seq"), "printf '1\\n'");
  executable(join(f.bin, "sleep"), "exit 0");
}

test.each([307, 308])(
  "full valid installer treats status %d as terminal under hostile proxy/curlrc",
  async (status) => {
    const f = copiedScripts();
    makeInstallerFixtureCommands(f);
    const target = await httpFixture((_request, response) =>
      response.end("target-sentinel"),
    );
    const direct = await httpFixture((_request, response) => {
      response.writeHead(status, {
        location: `http://127.0.0.1:${target.port}/redirect-sentinel`,
      });
      response.end("body-sentinel");
    });
    const proxy = await httpFixture((_request, response) =>
      response.end("proxy-sentinel"),
    );
    const curlHome = mkdtempSync(join(tmpdir(), "minime-h2-install-curl-home-"));
    const tempRoot = mkdtempSync(join(tmpdir(), "minime-h2-install-tmp-"));
    roots.push(curlHome, tempRoot);
    writeFileSync(
      join(curlHome, ".curlrc"),
      "location\nconnect-to = \"localhost::127.0.0.1:9\"\n",
    );
    const result = await run(
      ["bash", join(f.scripts, "install.sh"), "--skip-verify"],
      f.root,
      {
        PATH: `${f.bin}:/usr/bin:/bin`,
        H2_TRACE: f.trace,
        H2_REAL_CURL: REAL_CURL,
        TMPDIR: tempRoot,
        CURL_HOME: curlHome,
        OLLAMA_URL: `http://LOCALHOST.:${direct.port}/base`,
        OLLAMA_HOST: "198.51.100.9:7777",
        HTTP_PROXY: `http://127.0.0.1:${proxy.port}`,
        http_proxy: `http://127.0.0.1:${proxy.port}`,
        HTTPS_PROXY: `http://127.0.0.1:${proxy.port}`,
        https_proxy: `http://127.0.0.1:${proxy.port}`,
        ALL_PROXY: `http://127.0.0.1:${proxy.port}`,
        all_proxy: `http://127.0.0.1:${proxy.port}`,
      },
    );
    expect(result.code, `${result.out}\n${result.err}`).toBe(0);
    expect(result.out).toContain("status: degraded");
    expect(`${result.out}\n${result.err}`).not.toContain("body-sentinel");
    expect(`${result.out}\n${result.err}`).not.toContain("redirect-sentinel");
    expect(direct.seen.map((request) => request.url)).toEqual([
      "/base/api/tags",
      "/base/api/tags",
    ]);
    expect(
      direct.seen.every((request) => request.host === `LOCALHOST.:${direct.port}`),
    ).toBe(true);
    expect(target.seen).toHaveLength(0);
    expect(proxy.seen).toHaveLength(0);
    expect(readFileSync(f.trace, "utf8")).not.toContain("ollama serve");
    expect(
      `${result.out}\n${result.err}\n${readFileSync(f.trace, "utf8")}`,
    ).not.toContain("198.51.100.9");
    expect(readdirSync(tempRoot)).toEqual([]);
  },
);
```

Finally, make installer-launch behavior executable with fixture fakes:

```ts
test.each([
  {
    url: "http://127.0.0.1:11434",
    launched: true,
    bind: "127.0.0.1:11434",
    requestUrl: "http://127.0.0.1:11434/api/tags",
    host: "127.0.0.1:11434",
  },
  {
    url: "https://LOCALHOST.:11434/base",
    launched: false,
    bind: "",
    requestUrl: "https://localhost:11434/base/api/tags",
    host: "LOCALHOST.:11434",
  },
  {
    url: "http://localhost:11434/base",
    launched: false,
    bind: "",
    requestUrl: "http://localhost:11434/base/api/tags",
    host: "localhost:11434",
  },
])("server launch contract for $url", async ({ url, launched, bind, requestUrl, host }) => {
  const f = copiedScripts();
  executable(join(f.bin, "bun"), `
printf 'bun %s\\n' "$*" >> "$H2_TRACE"
[ "\${1:-}" = "--version" ] && printf '1.2.0\\n'
exit 0`);
  executable(join(f.bin, "curl"), 'printf "curl %s\\n" "$*" >> "$H2_TRACE"; exit 7');
  executable(join(f.bin, "ollama"), `
printf 'ollama %s host=%s\\n' "$*" "\${OLLAMA_HOST:-unset}" >> "$H2_TRACE"
exit 0`);
  executable(join(f.bin, "seq"), "printf '1\\n'");
  executable(join(f.bin, "sleep"), "exit 0");
  const result = await run(["bash", join(f.scripts, "install.sh"), "--skip-verify"], f.root, {
    PATH: `${f.bin}:/usr/bin:/bin`,
    H2_TRACE: f.trace,
    OLLAMA_URL: url,
    OLLAMA_HOST: "198.51.100.9:7777",
  });
  expect(result.code, `${result.out}\n${result.err}`).toBe(0);
  const trace = readFileSync(f.trace, "utf8");
  expect(trace).toContain(requestUrl);
  expect(trace).toContain(`Host: ${host}`);
  expect(trace.includes("ollama serve")).toBe(launched);
  if (launched) expect(trace).toContain(`host=${bind}`);
  expect(trace).not.toContain("198.51.100.9");
  expect(trace).not.toContain("ollama pull");
});
```

The copied scripts ensure `.env` creation and every launch/log occurs under the fixture
root. No test reads the repository's owner `.env`.

For invalid installer output assert:

```ts
expect(code).toBe(40);
expect(out).toMatch(/^\[1\/9\] FAIL +env: OLLAMA_URL rejected \([a-z_]+\)$/m);
expect(`${out}\n${err}`).toContain("ERROR:");
expect(`${out}\n${err}`).toContain("FIX:");
expect(`${out}\n${err}`).not.toContain(invalidUrl);
expect(trace).toBe("");
```

Add a hostile base-path/host matrix for both copied entrypoints. For each of
`http://198.51.100.9:11434/base` and
`https://user:credential-sentinel@localhost:11434/base`, replace the fixture `curl` with a
fake that emits distinct stdout/stderr markers and exits nonzero, then run the complete
`up.sh` and all-nine-step `install.sh` paths. Assert the fixed degraded/unreachable or
preflight output contains neither marker, configured URL/host/path, credential, nor fake
curl stderr; assert no proxy/redirect target receives a request, no curl trace contains the
hostile value, and every temporary response/error file is gone. This complements the valid
base-path Host-preservation cases and proves configured base paths/hosts cannot leak through
failure handling.

- [ ] **Step 2: Run shell tests red**

```bash
bun test test/h2.ollama-shell.test.ts test/install.test.ts
```

Expected: FAIL because existing curl honors ambient config/proxies, current pulls execute
`ollama pull`, launch trusts ambient `OLLAMA_HOST`, and 3xx is not explicitly classified as
failure.

- [ ] **Step 3: Implement one hardened shell request primitive**

In `scripts/lib.sh`, add:

```bash
ollama_api_url() {
  local api="$1" host port
  host="$OLLAMA_NORMALIZED_HOST"
  [ "$host" = "::1" ] && host="[::1]"
  if { [ "$OLLAMA_SCHEME" = http ] && [ "$OLLAMA_PORT" = 80 ]; } ||
     { [ "$OLLAMA_SCHEME" = https ] && [ "$OLLAMA_PORT" = 443 ]; }; then
    port=""
  else
    port=":$OLLAMA_PORT"
  fi
  printf '%s://%s%s%s%s' "$OLLAMA_SCHEME" "$host" "$port" "$OLLAMA_BASE_PATH" "$api"
}

ollama_request() {
  local method="$1" api="$2" data="$3" output="$4" url status timeout
  url="$(ollama_api_url "$api")"
  timeout="${MINIME_OLLAMA_CURL_TIMEOUT:-30}"
  [[ "$timeout" =~ ^[1-9][0-9]*$ ]] || timeout=30
  local -a args
  args=(-q --noproxy '*' --proxy '' --silent --show-error --max-time "$timeout"
        --request "$method" --header "Host: $OLLAMA_HOST_HEADER"
        --output "$output" --write-out '%{http_code}')
  if [ "$OLLAMA_NORMALIZED_HOST" = localhost ]; then
    args+=(--resolve "localhost:$OLLAMA_PORT:127.0.0.1")
  fi
  if [ -n "$data" ]; then
    args+=(--header 'content-type: application/json' --data-binary "$data")
  fi
  status="$(
    env -u HTTP_PROXY -u http_proxy -u HTTPS_PROXY -u https_proxy \
        -u ALL_PROXY -u all_proxy \
        curl "${args[@]}" "$url" 2>"$OLLAMA_ERROR"
  )" || return 1
  case "$status" in 2??) return 0 ;; *) return 1 ;; esac
}
```

`-q` is the first curl option. No `--location`, `--connect-to`, or proxy is allowed. Temp
output files are reserved privately by the exact callers below, parsed only after a 2xx
status, and deleted by an already-installed EXIT trap on every return.

Implement:

```bash
private_ollama_workspace() {
  local prefix="$1"
  umask 077
  OLLAMA_WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/$prefix.XXXXXX")" || return 1
  trap 'rm -rf -- "$OLLAMA_WORK_DIR"' EXIT
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM
  chmod 700 "$OLLAMA_WORK_DIR" || return 1
}

reserve_ollama_output() {
  OLLAMA_OUTPUT="$OLLAMA_WORK_DIR/response.json"
  OLLAMA_ERROR="$OLLAMA_WORK_DIR/curl.stderr"
  : > "$OLLAMA_OUTPUT" || return 1
  : > "$OLLAMA_ERROR" || return 1
  chmod 600 "$OLLAMA_OUTPUT" "$OLLAMA_ERROR" || return 1
}

valid_ollama_model() {
  [ -n "$1" ] && [[ "$1" != *[!A-Za-z0-9._:/-]* ]]
}

ollama_reachable() (
  private_ollama_workspace minime-ollama-tags || exit 1
  reserve_ollama_output || exit 1
  ollama_request GET /api/tags "" "$OLLAMA_OUTPUT"
)

ollama_has_model() (
  local model="$1" tags
  valid_ollama_model "$model" || exit 1
  private_ollama_workspace minime-ollama-model || exit 1
  reserve_ollama_output || exit 1
  ollama_request GET /api/tags "" "$OLLAMA_OUTPUT" || exit 1
  tags="$(tr -d '\r\n\t ' < "$OLLAMA_OUTPUT")"
  printf '%s' "$tags" | grep -Fq "\"name\":\"$model\"" ||
    printf '%s' "$tags" | grep -Fq "\"name\":\"$model:"
)
```

Escape backslash and quote in model names before building pull JSON:

```bash
json_string() {
  local value="$1"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  printf '"%s"' "$value"
}

ollama_pull_model() (
  local model="$1" timeout="$2" payload
  valid_ollama_model "$model" || exit 1
  private_ollama_workspace minime-ollama-pull || exit 1
  reserve_ollama_output || exit 1
  payload="{\"name\":$(json_string "$model"),\"stream\":false}"
  MINIME_OLLAMA_CURL_TIMEOUT="$timeout" \
    ollama_request POST /api/pull "$payload" "$OLLAMA_OUTPUT"
)
```

Never print the response or curl-error file. `private_ollama_workspace` is called inside a
subshell, so its EXIT/signal traps cannot overwrite caller traps. The output and error files
are created and chmodded before curl starts; curl stdout is captured as the private HTTP
response, curl stderr is captured as private `curl.stderr`, and redirect, curl failure,
timeout, success, and signals all remove both. Callers map every non-2xx/exit failure to a
fixed status/note and never print the captured curl error, URL, host, path, or response body.

- [ ] **Step 4: Replace CLI pull and constrain server launch**

In `scripts/install.sh`, replace `pull_model()` exactly; remove every `ollama pull`:

```bash
pull_model() {
  local model="$1" pid started=$SECONDS last_beat=0 elapsed
  ollama_has_model "$model" && { note "model present: $model"; return 0; }
  ollama_pull_model "$model" "$PULL_TIMEOUT" &
  pid=$!
  while kill -0 "$pid" 2>/dev/null; do
    sleep 2
    elapsed=$((SECONDS - started))
    if [ $((elapsed - last_beat)) -ge 20 ]; then
      note "pulling $model (${elapsed}s elapsed)"
      last_beat=$elapsed
    fi
    if [ "$elapsed" -ge "$PULL_TIMEOUT" ]; then
      kill "$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
      note "pull of $model timed out after ${PULL_TIMEOUT}s (MINIME_PULL_TIMEOUT)"
      return 1
    fi
  done
  if wait "$pid"; then
    note "pulled $model"
    return 0
  fi
  note "pull failed for $model"
  return 1
}
```

Replace server launch with:

```bash
if [ "$OLLAMA_CAN_LAUNCH" = 1 ] && have ollama && ! ollama_reachable; then
  nohup env -u OLLAMA_HOST OLLAMA_HOST="$OLLAMA_BIND_AUTHORITY" \
    ollama serve >.ollama-serve.log 2>&1 &
  for _ in $(seq 1 30); do ollama_reachable && break; sleep 1; done
fi
```

When `OLLAMA_CAN_LAUNCH=0`, do not launch; let existing degraded behavior report the
unreachable configured HTTPS/base-path proxy. All Ollama commands execute with ambient
`OLLAMA_HOST` removed or replaced by the validated bind.

Keep `--no-ollama` before the Ollama step's reachability/pull/launch branch so it makes zero
Ollama requests after the pure preflight.

- [ ] **Step 5: Run shell and install tests green**

```bash
bun test test/h2.ollama-shell.test.ts test/install.test.ts test/h2.ollama-url.test.ts
```

Expected: PASS; redirect/proxy/curlrc/ambient-host tripwires receive zero bytes; each
localhost curl argv contains the exact
`--resolve localhost:<port>:127.0.0.1` pin while preserving the configured Host; pulls use
the validated API; HTTPS/base paths never launch a mismatched server; installer exit/output
contracts remain exact. The full valid `up.sh` path and all-nine-step valid installer path
both use the hardened Host-preserving tags primitive, and their 307/308 Location targets
receive zero requests under all six hostile proxy variables.

- [ ] **Step 6: Commit bootstrap hardening**

```bash
git add scripts/lib.sh scripts/install.sh scripts/up.sh \
  test/h2.ollama-shell.test.ts test/install.test.ts
git commit -m "fix(ollama): harden bootstrap network paths"
```

### Task 4: Close ordering regressions and document the operator contract

**Files:**
- Modify: `test/h2.ollama-url.test.ts`
- Modify: `test/h2.ollama-http.test.ts`
- Modify: `test/h2.ollama-shell.test.ts`
- Modify: `.env.example`
- Modify: `AGENTS.md`
- Modify: `DECISIONS.md`
- Modify: `docs/SUBSYSTEMS.md`

**Interfaces:**
- Produces: evidence for every approved H2 edge case and operator-visible loopback contract

- [ ] **Step 1: Add the side-effect sentinel matrix**

The exported-environment and fixture-`.env` tests in Task 3 are the executable sentinel
matrix: their fake Bun/curl/Docker/Homebrew/Postgres/Ollama commands leave an empty trace and
their fixture-root listing proves no dependency or `.env` write happened. Do not duplicate
them with source-only assertions.

Add these complete CLI variants to `test/h2.ollama-url.test.ts` using Task 1's
`listeningSocket()` helper:

```ts
test.each([
  {
    name: "cloud-only routing",
    env: {
      EMBED_PROVIDER: "openrouter",
      CLASSIFY_PROVIDER: "openrouter",
      OPENROUTER_API_KEY: "fictional-key",
    },
  },
  { name: "mocked local provider", env: { MINIME_MOCK_OLLAMA: "1" } },
])("$name still validates OLLAMA_URL first", async ({ env }) => {
  const ollama = await listeningSocket();
  const cwd = mkdtempSync(join(tmpdir(), "minime-h2-provider-preflight-"));
  const invalid = `http://user:fictional-secret@127.0.0.1:${ollama.port}`;
  try {
    const proc = Bun.spawn(["bun", "run", join(REPO, "src/cli.ts"), "agenda"], {
      cwd,
      env: {
        ...process.env,
        ...env,
        NODE_ENV: "test",
        MINIME_SKIP_REPO_DOTENV: "1",
        OLLAMA_URL: invalid,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expect(code).toBe(40);
    expect(`${out}\n${err}`).toContain("ERROR: OLLAMA_URL is invalid");
    expect(`${out}\n${err}`).not.toContain(invalid);
    expect(ollama.connections()).toBe(0);
    expect(readdirSync(cwd)).toEqual([]);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    await ollama.close();
  }
});
```

- [ ] **Step 2: Add complete proxy/redirect coverage across every I/O operation**

The runtime fixture invokes:

```text
ollamaProvider().completeJson()
ollamaProvider().embed!()
fetchOllamaTags()
```

The shell fixture invokes:

```text
ollama_reachable
ollama_has_model
ollama_pull_model
install --no-ollama
up.sh
```

Task 2's complete tests cover generation, embedding, and tags through the same direct helper,
with all six proxy variables and operation-specific 307/308 assertions whose exact fixed
errors never include Location or response-body text, plus Host, pinned connection host,
HTTPS SNI options, pre-connect and in-flight aborts, invalid deadlines, a trickle-response
wall-clock deadline, and stream error. Task 3's complete tests cover reachable,
has-model, and pull with all six proxies plus hostile curlrc, both redirects, private cleanup,
literal model handling, Host, base path, launch, and executable curl-argv proof of the
`--resolve localhost:<port>:127.0.0.1` DNS pin. It also executes both the complete valid
`up.sh` PostgreSQL-and-Ollama path and a complete all-nine-step valid installer path against
fixture commands, covering terminal 307/308 tags responses under all six hostile proxy
variables, hostile curlrc, and `OLLAMA_HOST`. Extend the existing `--no-ollama` test to assert
both direct/proxy fixture counts remain zero. The coverage table itself is an acceptance
audit; do not add a source-only test named “coverage.”

- [ ] **Step 3: Document the configuration**

Replace the `.env.example` Ollama comment with:

```dotenv
# Ollama is local-only by construction. Allowed: http/https localhost (one unbracketed
# trailing dot only), canonical 127/8 IPv4, or bracketed ::1; a trailing dot on bracketed
# IPv6 or numeric IPv4 is syntax-invalid; optional port/base path. Credentials, redirects,
# proxies, DNS aliases, LAN/public hosts, and noncanonical numeric IPv4 are refused.
OLLAMA_URL=http://localhost:11434
```

In `AGENTS.md`, state next to the `OLLAMA_URL` table and degraded-mode recovery:

```text
OLLAMA_URL is loopback-only. Minime validates it before every CLI/install/up action, connects
directly without proxy environment or DNS for localhost, and never follows redirects.
HTTPS/base-path endpoints are treated as existing local proxies; Minime will not launch a
different plain ollama serve for them. Remote inference uses an explicit cloud provider.
```

- [ ] **Step 4: Append the H2 decision**

Append:

```markdown
## 2026-07-23 — H2: loopback-only Ollama

- **Context:** Ollama was always labeled local, but OLLAMA_URL accepted remote hosts, so a
  remote endpoint could bypass CLOUD_MAX_TIER and egress auditing.
- **Decision:** Accept only explicit loopback HTTP(S) authorities under one committed
  TypeScript/Bash corpus, rejecting raw control bytes before parsing and using last-key-wins
  `.env` semantics in both runtimes. Validate every CLI/provider/verifier/install/up path before
  effects. Runtime uses direct pinned node:http/https sockets; shell uses curl -q with
  proxies/config disabled, explicit localhost resolution, 2xx-only handling, no redirects,
  API-based pulls, explicit safe server binds, pre-connect abort refusal, and a true elapsed
  request deadline. Remote/LAN Ollama is unsupported.
- **Why:** A provider classified as local must be local by construction, including under
  hostile proxy, curl config, DNS/hosts, redirect, and OLLAMA_HOST environments.
- **Validated by:** shared URL/control-byte corpus (including DEL), duplicate and
  first-inline-comment `.env` parity sentinels, generation/embed/tags/pull redirect and proxy
  tripwires, localhost Host/SNI and exact curl `--resolve` assertions, zero-socket pre-abort
  and trickle-deadline tests, complete hermetic `up.sh` and all-nine-step installer paths,
  and the full gate.
- **Approved by:** owner-approved pre-W5 hardening design (2026-07-23).
```

- [ ] **Step 5: Update only the provider subsystem row**

In `docs/SUBSYSTEMS.md`, add `src/util/ollama-url.ts`, `src/llm/ollama-http.ts`, and
`scripts/lib.sh` to Provider layer + egress audit What/where/dependencies; add the shared
corpus/direct-network tests to its eval text; append the H2 decision heading to Maintenance.
Do not add a subsystem.

- [ ] **Step 6: Run targeted and full branch gates**

```bash
bun test test/h2.ollama-url.test.ts test/h2.ollama-http.test.ts \
  test/h2.ollama-shell.test.ts test/providers.test.ts test/install.test.ts \
  test/m13.provider-routing.test.ts
bun test
bunx tsc --noEmit
bunx biome check .
git diff --check
make check-subsystems
make verify
```

Expected: all commands exit 0; Biome makes no changes; offline MinimeBench floors remain
green; no test contacted a non-fixture network endpoint.

- [ ] **Step 7: Commit documentation and final regressions**

```bash
git add test/h2.ollama-url.test.ts test/h2.ollama-http.test.ts \
  test/h2.ollama-shell.test.ts .env.example AGENTS.md DECISIONS.md docs/SUBSYSTEMS.md
git commit -m "docs: record loopback-only Ollama contract"
```

### Task 5: Branch review and H3 handoff

**Files:**
- Review: every H2 branch change
- Do not modify: approved design, H3/H1/H4/H5 production files, owner `.env`, owner data

**Interfaces:**
- Produces: binding-reviewed H2 merge SHA consumed by H3

- [ ] **Step 1: Capture acceptance evidence**

```bash
test -n "${WORKTREE_PATH:?set the pinned H2 worktree path}"
test -n "${START_SHA:?recorded when the H2 worktree was created}"
test "$START_SHA" = "$PLAN_BASE_SHA"
git -C "$WORKTREE_PATH" status --short
git -C "$WORKTREE_PATH" log --oneline --decorate -5
git -C "$WORKTREE_PATH" diff "$START_SHA"...HEAD --stat
git -C "$WORKTREE_PATH" diff "$START_SHA"...HEAD --check
```

Expected: only H2-owned files changed, focused commits are present, and diff check is silent.

- [ ] **Step 2: Run complete-branch advisory review**

Generate the review packet only with `git -C "$WORKTREE_PATH" diff "$START_SHA"...HEAD`
(plus `--stat`/`--check`); do not diff against a branch name or an implicit working-tree
baseline. Assign a fresh `first_pass_reviewer_luna`. Require explicit findings on raw authority
grammar/C0-and-DEL rejection, TypeScript/Bash corpus, duplicate-key parity, and first
whitespace-`#` comment parity; preflight order; direct socket pinning; Host/SNI; exact shell
`--resolve` argv; true elapsed deadlines; abort-before-connect; generation/embed/tags/pull
307/308 refusal; all six proxy cases; curl config; API pull; server launch; the complete
valid `up.sh` and all-nine-step installer paths; output secrecy; zero local egress events;
and fixture offline safety.

Expected: no unresolved Critical or Important finding.

- [ ] **Step 3: Adjudicate a disputed Luna Critical when necessary**

Send only the disputed finding and evidence to a fresh `critical_adjudicator_sol`. Apply the
disposition, rerun targeted/full gates, and return changed code to Luna.

- [ ] **Step 4: Obtain binding Sol review**

Assign a fresh `final_reviewer_sol` to the final branch diff and gate evidence.

Expected: explicit binding `PASS`. Stop on `BLOCK`; do not merge or cut H3.

- [ ] **Step 5: Hand off the reviewed merge**

After merge:

```bash
git rev-parse HEAD
git show HEAD:src/util/ollama-url.ts | rg "validateOllamaUrl|ollamaPreflight"
git show HEAD:scripts/lib.sh | rg "validate_ollama_url|ollama_request"
```

Expected: the reviewed H2 merge SHA and both runtime/shell guards. Cut H3 only from this SHA.
