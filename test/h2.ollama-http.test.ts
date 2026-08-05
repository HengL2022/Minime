import { afterEach, expect, test } from "bun:test";
import {
  type IncomingMessage,
  type ServerResponse,
  createServer,
  request as nodeRequest,
} from "node:http";
import type { LookupFunction } from "node:net";
import { ollamaProvider } from "../src/llm/ollama";
import { fetchOllamaTags, ollamaNodeRequestOptions, ollamaRequest } from "../src/llm/ollama-http";
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
  closers.push(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
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
])(
  "$operation status $status is fixed and never follows Location",
  async ({ status, operation }) => {
    const target = await fixture((_request, _raw, response) => json(response, { reached: true }));
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
  },
);

test("all proxy environment variants are ignored", async () => {
  const proxy = await fixture((_request, _raw, response) => json(response, { proxy: true }));
  const direct = await fixture((request, _raw, response) => {
    if (request.url === "/api/generate") json(response, { response: '{"direct":true}' });
    else if (request.url === "/api/embed") json(response, { embeddings: [[0.75]] });
    else if (request.url === "/api/tags")
      json(response, { models: [{ name: "nomic-embed-text" }] });
    else response.writeHead(404).end();
  });
  for (const key of proxyKeys) process.env[key] = `http://127.0.0.1:${proxy.port}`;
  config.ollamaUrl = `http://localhost:${direct.port}`;
  const provider = ollamaProvider();
  expect(await provider.completeJson("fictional")).toBe('{"direct":true}');
  expect(await provider.embed!(["fictional text"])).toEqual([[0.75]]);
  expect(await fetchOllamaTags(validateOllamaUrl(config.ollamaUrl))).toEqual(["nomic-embed-text"]);
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
  expect((options as typeof options & { servername?: string }).servername).toBe("localhost");
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
  await expect(ollamaRequest(endpoint, "/api/tags", {}, { timeoutMs: 40 })).rejects.toThrow(
    /deadline/,
  );
  expect(performance.now() - started).toBeLessThan(500);
});

test.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1.5])(
  "invalid timeout %p fails before opening a socket",
  async (timeoutMs) => {
    const direct = await fixture((_request, _raw, response) => response.end("{}"));
    const endpoint = validateOllamaUrl(`http://127.0.0.1:${direct.port}`);
    await expect(ollamaRequest(endpoint, "/api/tags", {}, { timeoutMs })).rejects.toThrow(
      /positive integer/,
    );
    await Bun.sleep(20);
    expect(direct.connections()).toBe(0);
  },
);

test.each([2_147_483_648, Number.MAX_SAFE_INTEGER])(
  "timeout %p fails before opening a socket with the fixed upper-bound error",
  async (timeoutMs) => {
    const direct = await fixture((_request, _raw, response) => response.end("{}"));
    const endpoint = validateOllamaUrl(`http://127.0.0.1:${direct.port}`);
    await expect(ollamaRequest(endpoint, "/api/tags", {}, { timeoutMs })).rejects.toThrow(
      "ollama timeoutMs must be a positive integer no greater than 2147483647",
    );
    await Bun.sleep(20);
    expect(direct.connections()).toBe(0);
  },
);

test("maximum supported timeout is accepted by an immediately responding fixture", async () => {
  const direct = await fixture((_request, _raw, response) => response.end("{}"));
  const endpoint = validateOllamaUrl(`http://127.0.0.1:${direct.port}`);
  const response = await ollamaRequest(endpoint, "/api/tags", {}, { timeoutMs: 2_147_483_647 });
  expect(response.status).toBe(200);
  expect(direct.seen).toHaveLength(1);
});

test("status above 599 rejects before buffering with a fixed error", async () => {
  const direct = await fixture((_request, _raw, response) => {
    response.writeHead(700, { "x-status-text-sentinel": "do-not-leak" });
    response.end("response-body-sentinel");
  });
  const endpoint = validateOllamaUrl(`http://127.0.0.1:${direct.port}`);
  let message = "";
  try {
    await ollamaRequest(endpoint, "/api/tags");
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  expect(message).toBe("ollama response invalid status");
  expect(message).not.toContain("700");
  expect(message).not.toContain("response-body-sentinel");
  expect(message).not.toContain("do-not-leak");
  expect(direct.seen).toHaveLength(1);
});

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
