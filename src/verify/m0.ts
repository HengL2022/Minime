// make verify-m0: DB reachable, extensions present, required Ollama models listed
// (or mocked when MINIME_MOCK_OLLAMA=1 / CI).

import { closeDb, sql } from "../db/client";
import { config } from "../util/config";

let failed = false;
const check = (name: string, ok: boolean, detail?: string) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failed = true;
};

try {
  const [r] = await sql`select 1 as ok`;
  check("postgres reachable", r?.ok === 1, config.databaseUrl.replace(/:[^:@/]+@/, ":***@"));
  const exts = (await sql`select extname from pg_extension`).map((e: any) => e.extname);
  check("extension: vector", exts.includes("vector"));
  check("extension: pgcrypto", exts.includes("pgcrypto"));
} catch (e) {
  check("postgres reachable", false, e instanceof Error ? e.message : String(e));
}

if (config.mockOllama) {
  check("ollama models", true, "mocked (MINIME_MOCK_OLLAMA=1)");
} else {
  try {
    const res = await fetch(`${config.ollamaUrl}/api/tags`, { signal: AbortSignal.timeout(3000) });
    const tags = (await res.json()) as { models: { name: string }[] };
    const names = tags.models.map((m) => m.name);
    const has = (model: string) => names.some((n) => n === model || n.startsWith(`${model}:`));
    check(`ollama model: ${config.embedModel}`, has(config.embedModel));
    check(`ollama model: ${config.classifyModel}`, has(config.classifyModel));
  } catch (e) {
    check("ollama reachable", false, e instanceof Error ? e.message : String(e));
  }
}

await closeDb();
process.exit(failed ? 1 : 0);
