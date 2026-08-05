import * as http from "node:http";
import * as https from "node:https";
import type { OllamaEndpoint } from "../util/ollama-url";

export interface OllamaRequestOptions {
  timeoutMs?: number;
}

const MAX_TIMEOUT_MS = 2_147_483_647;

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
  if (timeoutMs > MAX_TIMEOUT_MS) {
    throw new RangeError("ollama timeoutMs must be a positive integer no greater than 2147483647");
  }
  if (init.signal?.aborted) {
    throw new Error("ollama request aborted");
  }
  return await new Promise<Response>((resolve, reject) => {
    let settled = false;
    let req: http.ClientRequest | undefined;
    const deadline = setTimeout(() => {
      const error = new Error("ollama request deadline exceeded");
      finish(error);
      req?.destroy(error);
    }, timeoutMs);
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
      finish(error);
      req?.destroy(error);
    };
    init.signal?.addEventListener("abort", onAbort, { once: true });
    if (init.signal?.aborted) {
      onAbort();
      return;
    }
    try {
      req = transport.request(ollamaNodeRequestOptions(endpoint, apiPath, init), (res) => {
        const status = res.statusCode;
        if (status === undefined) {
          res.destroy();
          finish(new Error("ollama response missing status"));
          return;
        }
        if (status > 599) {
          const error = new Error("ollama response invalid status");
          finish(error);
          res.destroy(error);
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
      });
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
