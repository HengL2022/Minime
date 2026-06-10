// Test preload: runs before any test file imports src/. Tests are fully offline (I1):
// Ollama is mocked, the DB is the local minime_test database.

import { afterAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DATABASE_URL =
  process.env.MINIME_TEST_DATABASE_URL ?? "postgres://minime:minime@localhost:5432/minime_test";
process.env.MINIME_MOCK_OLLAMA = "1";
process.env.TZ = "Asia/Singapore";
process.env.MINIME_DATA_DIR = mkdtempSync(join(tmpdir(), "minime-test-"));

// Close the postgres pool after the whole run, or open sockets keep bun alive forever.
afterAll(async () => {
  const { closeDb } = await import("../src/db/client");
  await closeDb();
});
