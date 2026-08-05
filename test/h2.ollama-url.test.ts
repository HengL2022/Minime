import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ollamaProvider } from "../src/llm/ollama";
import { config, parseDotenv } from "../src/util/config";
import { OllamaUrlError, ollamaPreflight, validateOllamaUrl } from "../src/util/ollama-url";

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
  expect(() => validateOllamaUrl(url)).toThrow(expect.objectContaining({ rule: "syntax" }));
  expect(shellVerdict(url)).toEqual({ ok: false, rule: "syntax" });
});

test.each([
  "http://localhost:11434/base path",
  "http://localhost:11434/base/é",
  "http://localhost:11434/base/你好",
])("TS/Bash reject raw endpoint bytes before normalization: %s", (url) => {
  expect(() => validateOllamaUrl(url)).toThrow(expect.objectContaining({ rule: "endpoint_byte" }));
  expect(shellVerdict(url)).toEqual({ ok: false, rule: "endpoint_byte" });
});

test.each([
  "http://localhost:11434/%2efoo",
  "http://localhost:11434/a%2eb",
  "http://localhost:11434/base/nested/%2E%2efoo",
])("TS/Bash reject every raw percent-encoded dot occurrence before normalization: %s", (url) => {
  expect(() => validateOllamaUrl(url)).toThrow(expect.objectContaining({ rule: "path_segment" }));
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
      }) as unknown as typeof fetch),
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
    text: "OLLAMA_URL=http://localhost:11434\n" + "OLLAMA_URL=http://192.168.50.4:11434\n",
    expected: "http://192.168.50.4:11434",
    ok: false,
  },
  {
    name: "first remote then loopback",
    text: "OLLAMA_URL=http://192.168.50.4:11434\n" + "OLLAMA_URL=http://localhost:11434\n",
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
    const env: NodeJS.ProcessEnv = { ...process.env, MINIME_LIB_SKIP_RESOLVE: "1" };
    env.OLLAMA_URL = undefined;
    const script =
      'cd "$2"; . "$1"; unset OLLAMA_URL; resolve_ollama_url; ' +
      'if validate_ollama_url "$OLLAMA_URL"; then verdict=ok; else verdict="$OLLAMA_URL_RULE"; fi; ' +
      'printf "%s\\t%s" "$OLLAMA_URL" "$verdict"';
    const proc = Bun.spawnSync(["bash", "-c", script, "_", join(REPO, "scripts/lib.sh"), cwd], {
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(proc.exitCode, proc.stderr.toString()).toBe(0);
    const [shellValue, verdict] = proc.stdout.toString().split("\t");
    expect(shellValue).toBe(parseDotenv(text).OLLAMA_URL);
    expect(shellValue).toBe(expected);
    expect(verdict === "ok").toBe(ok);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

async function listeningSocket() {
  let connections = 0;
  const server = createServer((socket) => {
    connections += 1;
    socket.destroy();
  });
  await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture did not bind TCP");
  return {
    port: address.port,
    connections: () => connections,
    close: () =>
      new Promise<void>((resolvePromise, reject) =>
        server.close((error) => (error ? reject(error) : resolvePromise())),
      ),
  };
}

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
      await Promise.all([direct.close(), proxy.close()]);
      rmSync(cwd, { recursive: true, force: true });
    }
  }
});
