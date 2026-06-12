// Test preload: runs before any test file imports src/. Tests are fully offline (I1):
// Ollama is mocked, the DB is the local minime_test database.

import { afterAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Tests always run against the minime_test database — derived from DATABASE_URL (bun
// auto-loads .env) so non-default ports (e.g. installer-provisioned 5433) just work.
function testDbUrl(): string {
  if (process.env.MINIME_TEST_DATABASE_URL) return process.env.MINIME_TEST_DATABASE_URL;
  if (process.env.DATABASE_URL) {
    const u = new URL(process.env.DATABASE_URL);
    u.pathname = "/minime_test";
    return u.toString();
  }
  return "postgres://minime:minime@localhost:5432/minime_test";
}
process.env.DATABASE_URL = testDbUrl();
process.env.MINIME_MOCK_OLLAMA = "1";
process.env.TZ = "Asia/Singapore";
// hermetic against the owner's .env (bun auto-loads it): tests always start from the
// local defaults; provider-specific tests patch the config object themselves
process.env.EMBED_PROVIDER = "ollama";
process.env.CLASSIFY_PROVIDER = "ollama";
// the rerank stage must never fire in tests (live HTTP + order changes); rerank tests
// inject their own config and fetch
delete process.env.RERANK_URL;
// backup()/dbSnapshot() must never invoke real restic/pg_dump in tests (I1, offline). The
// owner's .env (bun auto-loads it) sets these; clear them so the unconfigured path fires.
delete process.env.RESTIC_REPOSITORY;
delete process.env.RESTIC_PASSWORD_FILE;
process.env.MINIME_DATA_DIR = mkdtempSync(join(tmpdir(), "minime-test-"));

// Close the postgres pool after the whole run, or open sockets keep bun alive forever.
afterAll(async () => {
  const { closeDb } = await import("../src/db/client");
  await closeDb();
});
