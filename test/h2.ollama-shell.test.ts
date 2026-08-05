import { afterEach, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { type ServerResponse, createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

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
  writeFileSync(
    join(root, ".env.example"),
    "# fictional fixture\nDATABASE_URL=postgres://minime:minime@localhost:5432/minime\n",
    { mode: 0o600 },
  );
  for (const name of ["lib.sh", "install.sh", "up.sh"]) {
    const target = join(scripts, name);
    writeFileSync(target, readFileSync(join(REPO, "scripts", name)), { mode: 0o700 });
    chmodSync(target, 0o700);
  }
  for (const name of ["docker", "brew", "curl", "pg_isready", "psql"]) {
    executable(
      join(bin, name),
      `printf '%s %s\\n' ${JSON.stringify(name)} "$*" >> "$H2_TRACE"; exit 91`,
    );
  }
  return { root, scripts, bin, trace };
}

async function run(argv: string[], cwd: string, env: Record<string, string | undefined>) {
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
  responder: (
    request: { method: string; url: string; host: string; body: string },
    response: ServerResponse,
  ) => void,
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
  closers.push(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  );
  return { port: address.port, seen };
}

function hangingHttpFixture() {
  let request = "";
  let openConnections = 0;
  const server = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open() {
        openConnections += 1;
      },
      data(_socket, data) {
        request += Buffer.from(data).toString("utf8");
      },
      close() {
        openConnections -= 1;
      },
      error(_socket, error) {
        throw error;
      },
    },
  });
  closers.push(async () => {
    server.stop(true);
  });
  return {
    port: server.port,
    receivedPull: () =>
      request.includes("POST /api/pull ") &&
      request.includes('{"name":"nomic-embed-text","stream":false}'),
    openConnections: () => openConnections,
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("shell fixture condition timed out");
    await Bun.sleep(10);
  }
}

async function libCall(lib: string, shell: string, env: Record<string, string | undefined>) {
  return run(["bash", "-c", '. "$1"; eval "$2"', "_", lib, shell], REPO, {
    MINIME_LIB_SKIP_RESOLVE: "1",
    ...env,
  });
}

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

test("shell validator matches every normative URL corpus row", async () => {
  for (const row of corpus()) {
    // Invoke the validator with the corpus value as a positional argument so no
    // fixture URL is exported into the shell process environment.
    const verdict = await run(
      [
        "bash",
        "-c",
        '. "$1"; if validate_ollama_url "$2"; then printf "ok\\n"; else printf "%s\\n" "$OLLAMA_URL_RULE"; exit 9; fi',
        "_",
        join(REPO, "scripts/lib.sh"),
        row.url,
      ],
      REPO,
      { MINIME_LIB_SKIP_RESOLVE: "1" },
    );
    expect(verdict.code === 0).toBe(row.verdict === "accept");
    expect(verdict.out.trim()).toBe(row.verdict === "accept" ? "ok" : row.rule);
  }
});

test("bootstrap scripts contain no executable or copyable ollama pull token", () => {
  for (const name of ["install.sh", "up.sh"]) {
    const source = readFileSync(join(REPO, "scripts", name), "utf8");
    expect(source).not.toMatch(/\bollama\s+pull\b/);
  }
});

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
      "OLLAMA_URL=http://localhost:11434\n" + "OLLAMA_URL=http://192.168.10.20:11434\n",
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
    "DATABASE_URL=postgres://minime:minime@localhost:5432/minime\n" +
      "OLLAMA_URL=http://192.168.10.20:11434\n" +
      "OLLAMA_URL=http://localhost:11434\n",
    { mode: 0o600 },
  );
  const result = await run(
    ["bash", join(f.scripts, "install.sh"), "--dry-run", "--no-ollama"],
    f.root,
    { PATH: `${f.bin}:/usr/bin:/bin`, H2_TRACE: f.trace, OLLAMA_URL: undefined },
  );
  expect(result.code, `${result.out}\n${result.err}`).toBe(0);
  expect(readFileSync(f.trace, "utf8")).toBe("docker info\n");
});

test.each([
  { available: false, native: false, detail: "would install native postgres" },
  { available: true, native: false, detail: "would docker compose up pg16" },
  { available: true, native: true, detail: "would install native postgres" },
])(
  "dry-run detects Docker=$available and native=$native without side effects",
  async ({ available, native, detail }) => {
    const f = copiedScripts();
    executable(
      join(f.bin, "docker"),
      `printf 'docker %s\\n' "$*" >> "$H2_TRACE"\n[ "$*" = info ] && exit ${available ? 0 : 1}\nexit 91`,
    );
    const result = await run(
      [
        "bash",
        join(f.scripts, "install.sh"),
        "--dry-run",
        "--no-ollama",
        ...(native ? ["--native"] : []),
      ],
      f.root,
      {
        PATH: `${f.bin}:/usr/bin:/bin`,
        H2_TRACE: f.trace,
        OLLAMA_URL: "http://localhost:11434",
      },
    );
    expect(result.code, `${result.out}\n${result.err}`).toBe(0);
    expect(result.out).toContain(detail);
    expect(readFileSync(f.trace, "utf8")).toBe("docker info\n");
  },
);

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
  expect(readFileSync(f.trace, "utf8")).toBe("docker info\n");
  expect(direct.seen).toHaveLength(0);
  expect(proxy.seen).toHaveLength(0);
  const defaults = await run(
    ["bash", join(f.scripts, "install.sh"), "--dry-run", "--no-ollama"],
    f.root,
    { PATH: `${f.bin}:/usr/bin:/bin`, H2_TRACE: f.trace, OLLAMA_URL: undefined },
  );
  expect(defaults.code).toBe(0);
  expect(readFileSync(f.trace, "utf8")).toBe("docker info\ndocker info\n");
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
  expect(direct.seen).toHaveLength(0);
  expect(proxy.seen).toHaveLength(0);
});

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
  writeFileSync(join(curlHome, ".curlrc"), 'location\nconnect-to = "localhost::127.0.0.1:9"\n');
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
  expect(JSON.parse(direct.seen[2]!.body)).toEqual({ name: "nomic-embed-text", stream: false });
  const curlLines = readFileSync(curlTrace, "utf8").trim().split("\n");
  expect(
    curlLines.filter((line) => line.includes(`--resolve localhost:${direct.port}:127.0.0.1`)),
  ).toHaveLength(3);
  expect(curlLines.every((line) => line.includes(`--header Host: LOCALHOST.:${direct.port}`))).toBe(
    true,
  );
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
    `printf '%s\\n' ${JSON.stringify(stdoutSentinel)}\nprintf '%s\\n' ${JSON.stringify(stderrSentinel)} >&2\nexit 77`,
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
    expect(`${result.out}\n${result.err}`).not.toContain(stdoutSentinel);
    expect(`${result.out}\n${result.err}`).not.toContain(stderrSentinel);
  }
  expect(readdirSync(tempRoot)).toEqual(["bin"]);
});

test.each([307, 308])(
  "shell status %d never reaches redirect Location for tags or pull",
  async (status) => {
    const target = await httpFixture((_request, response) => response.end("target"));
    const direct = await httpFixture((_request, response) => {
      response.writeHead(status, { location: `http://127.0.0.1:${target.port}/response-sentinel` });
      response.end("body-sentinel");
    });
    const lib = join(REPO, "scripts/lib.sh");
    for (const call of [
      "ollama_preflight && ollama_reachable",
      "ollama_preflight && ollama_pull_model nomic-embed-text 3",
    ]) {
      const result = await libCall(lib, call, { OLLAMA_URL: `http://localhost:${direct.port}` });
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
    {
      OLLAMA_URL: `http://127.0.0.1:${hanging.port}`,
      TMPDIR: tempRoot,
    },
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

test("external TERM promptly stops a real curl pull and cleans private files", async () => {
  const hanging = hangingHttpFixture();
  const tempRoot = mkdtempSync(join(tmpdir(), "minime-h2-curl-external-term-"));
  const controlRoot = mkdtempSync(join(tmpdir(), "minime-h2-curl-control-"));
  roots.push(tempRoot, controlRoot);
  const pidFile = join(controlRoot, "pull.pid");
  const clean = Object.fromEntries(
    Object.entries({
      ...process.env,
      MINIME_LIB_SKIP_RESOLVE: "1",
      OLLAMA_URL: `http://127.0.0.1:${hanging.port}`,
      TMPDIR: tempRoot,
      H2_PID_FILE: pidFile,
      PATH: `${dirname(REAL_CURL)}:/usr/bin:/bin`,
    }).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
  const shell = [
    '. "$1"',
    "ollama_pull_model() {",
    '  local model="$1" timeout="$2" payload',
    '  valid_ollama_model "$model" || exit 1',
    "  private_ollama_workspace minime-ollama-pull || exit 1",
    "  reserve_ollama_output || exit 1",
    '  payload="{\\"name\\":$(json_string "$model"),\\"stream\\":false}"',
    '  MINIME_OLLAMA_CURL_TIMEOUT="$timeout" ollama_request POST /api/pull "$payload" "$OLLAMA_OUTPUT"',
    "}",
    "ollama_preflight",
    "ollama_pull_model nomic-embed-text 3 &",
    "child=$!",
    'printf "%s\\n" "$child" > "$H2_PID_FILE"',
    'wait "$child"',
  ].join("\n");
  const proc = Bun.spawn(["bash", "-c", shell, "_", join(REPO, "scripts/lib.sh")], {
    cwd: REPO,
    env: clean,
    stdout: "pipe",
    stderr: "pipe",
  });
  await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").trim().length > 0);
  await waitFor(() => hanging.receivedPull() && hanging.openConnections() === 1);
  const childPid = Number.parseInt(readFileSync(pidFile, "utf8").trim(), 10);
  const started = Date.now();
  process.kill(childPid, "SIGTERM");
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  expect(code, `${out}\n${err}`).toBe(143);
  expect(Date.now() - started).toBeLessThan(1_000);
  await waitFor(() => hanging.openConnections() === 0);
  expect(readdirSync(tempRoot)).toEqual([]);
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

function makeUpFixtureCommands(f: ReturnType<typeof copiedScripts>): void {
  executable(
    join(f.bin, "docker"),
    `printf 'docker %s\\n' "$*" >> "$H2_TRACE"\ncase "$*" in\n  *"select 1 from pg_database"*) printf '1\\n' ;;\nesac\nexit 0`,
  );
  executable(join(f.bin, "curl"), 'exec "$H2_REAL_CURL" "$@"');
}

test("valid up.sh uses hardened tags with pinned Host and ignores proxy/curlrc/OLLAMA_HOST", async () => {
  const f = copiedScripts();
  makeUpFixtureCommands(f);
  const direct = await httpFixture((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"models":[{"name":"nomic-embed-text:latest"},{"name":"llama3.1:8b"}]}');
  });
  const proxy = await httpFixture((_request, response) => response.end("proxy-sentinel"));
  const curlHome = mkdtempSync(join(tmpdir(), "minime-h2-up-curl-home-"));
  const tempRoot = mkdtempSync(join(tmpdir(), "minime-h2-up-tmp-"));
  roots.push(curlHome, tempRoot);
  writeFileSync(join(curlHome, ".curlrc"), 'location\nconnect-to = "localhost::127.0.0.1:9"\n');
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
  expect(direct.seen.every((request) => request.host === `LOCALHOST.:${direct.port}`)).toBe(true);
  expect(proxy.seen).toHaveLength(0);
  expect(`${result.out}\n${result.err}\n${readFileSync(f.trace, "utf8")}`).not.toContain(
    "198.51.100.9",
  );
  expect(readdirSync(tempRoot)).toEqual([]);
});

test.each([
  "http://198.51.100.9:11434/base",
  "https://user:credential-sentinel@localhost:11434/base",
])("hostile configured endpoint %s cannot leak through either entrypoint", async (url) => {
  const markerOut = "H2_FAKE_CURL_STDOUT_SENTINEL";
  const markerErr = "H2_FAKE_CURL_STDERR_SENTINEL";
  for (const name of ["up.sh", "install.sh"] as const) {
    const f = copiedScripts();
    executable(
      join(f.bin, "curl"),
      `printf '%s\\n' ${JSON.stringify(markerOut)}\nprintf '%s\\n' ${JSON.stringify(markerErr)} >&2\nexit 77`,
    );
    const args = name === "install.sh" ? ["--skip-verify"] : [];
    const result = await run(["bash", join(f.scripts, name), ...args], f.root, {
      PATH: `${f.bin}:/usr/bin:/bin`,
      HOME: f.root,
      H2_TRACE: f.trace,
      OLLAMA_URL: url,
      OLLAMA_HOST: "198.51.100.9:7777",
    });
    expect(result.code).toBe(40);
    expect(`${result.out}\n${result.err}`).not.toContain(markerOut);
    expect(`${result.out}\n${result.err}`).not.toContain(markerErr);
    expect(`${result.out}\n${result.err}`).not.toContain(url);
    expect(`${result.out}\n${result.err}`).not.toContain("credential-sentinel");
    expect(readFileSync(f.trace, "utf8")).toBe("");
  }
});

test.each([307, 308])(
  "valid up.sh treats status %d as terminal and never reaches Location",
  async (status) => {
    const f = copiedScripts();
    makeUpFixtureCommands(f);
    const target = await httpFixture((_request, response) => response.end("target-sentinel"));
    const direct = await httpFixture((_request, response) => {
      response.writeHead(status, { location: `http://127.0.0.1:${target.port}/redirect-sentinel` });
      response.end("body-sentinel");
    });
    const proxy = await httpFixture((_request, response) => response.end("proxy-sentinel"));
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

function makeInstallerFixtureCommands(f: ReturnType<typeof copiedScripts>): void {
  executable(
    join(f.bin, "bun"),
    `printf 'bun %s\\n' "$*" >> "$H2_TRACE"\nif [ "\${1:-}" = "--version" ]; then printf '1.2.0\\n'; exit 0; fi\ncase "$*" in\n  *src/cli.ts*) printf '{"ok":true}\\n' ;;\nesac\nexit 0`,
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
    const target = await httpFixture((_request, response) => response.end("target-sentinel"));
    const direct = await httpFixture((_request, response) => {
      response.writeHead(status, { location: `http://127.0.0.1:${target.port}/redirect-sentinel` });
      response.end("body-sentinel");
    });
    const proxy = await httpFixture((_request, response) => response.end("proxy-sentinel"));
    const curlHome = mkdtempSync(join(tmpdir(), "minime-h2-install-curl-home-"));
    const tempRoot = mkdtempSync(join(tmpdir(), "minime-h2-install-tmp-"));
    roots.push(curlHome, tempRoot);
    writeFileSync(join(curlHome, ".curlrc"), 'location\nconnect-to = "localhost::127.0.0.1:9"\n');
    const result = await run(["bash", join(f.scripts, "install.sh"), "--skip-verify"], f.root, {
      PATH: `${f.bin}:/usr/bin:/bin`,
      HOME: f.root,
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
    expect(result.out).toContain("status: degraded");
    expect(`${result.out}\n${result.err}`).not.toContain("body-sentinel");
    expect(`${result.out}\n${result.err}`).not.toContain("redirect-sentinel");
    expect(direct.seen.map((request) => request.url)).toEqual(["/base/api/tags", "/base/api/tags"]);
    expect(direct.seen.every((request) => request.host === `LOCALHOST.:${direct.port}`)).toBe(true);
    expect(target.seen).toHaveLength(0);
    expect(proxy.seen).toHaveLength(0);
    expect(readFileSync(f.trace, "utf8")).not.toContain("ollama serve");
    expect(`${result.out}\n${result.err}\n${readFileSync(f.trace, "utf8")}`).not.toContain(
      "198.51.100.9",
    );
    expect(readdirSync(tempRoot)).toEqual([]);
  },
);

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
  executable(
    join(f.bin, "bun"),
    `printf 'bun %s\\n' "$*" >> "$H2_TRACE"\n[ "\${1:-}" = "--version" ] && printf '1.2.0\\n'\nexit 0`,
  );
  executable(join(f.bin, "curl"), 'printf "curl %s\\n" "$*" >> "$H2_TRACE"; exit 7');
  executable(
    join(f.bin, "ollama"),
    `printf 'ollama %s host=%s\\n' "$*" "\${OLLAMA_HOST:-unset}" >> "$H2_TRACE"\nexit 0`,
  );
  executable(join(f.bin, "seq"), "printf '1\\n'");
  executable(join(f.bin, "sleep"), "exit 0");
  const result = await run(["bash", join(f.scripts, "install.sh"), "--skip-verify"], f.root, {
    PATH: `${f.bin}:/usr/bin:/bin`,
    HOME: f.root,
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
