import {
  RestoreSchemaGateError,
  type RestoreSchemaGateStage,
  runRestoreSchemaGate,
} from "../ops/restore-schema-gate";
import { parseLocalPostgresUrl } from "../util/postgres-url";

const RESTORE_SCHEMA_TARGET = /^(?:minime_drill|minime_restore)$/;
const ISOLATED_REPOSITORY_URL = "postgres://minime@127.0.0.1:1/minime";

function assertRestoreSchemaTarget(databaseUrl: string): void {
  try {
    parseLocalPostgresUrl(databaseUrl, RESTORE_SCHEMA_TARGET);
  } catch {
    throw new RestoreSchemaGateError("target_boundary");
  }
}

function fixedStage(error: unknown): RestoreSchemaGateStage {
  return error instanceof RestoreSchemaGateError ? error.stage : "migration";
}

export async function runDatabaseRestoreSchemaGate(databaseUrl: string): Promise<void> {
  assertRestoreSchemaTarget(databaseUrl);

  // repo.ts imports the ordinary client module. Keep those unused lazy pools pinned to a guarded,
  // unreachable test endpoint; only the explicitly injected pool below can reach the scratch DB.
  process.env.MINIME_SKIP_REPO_DOTENV = "1";
  process.env.DATABASE_URL = ISOLATED_REPOSITORY_URL;
  process.env.MINIME_APP_DATABASE_URL = ISOLATED_REPOSITORY_URL;

  let failure: RestoreSchemaGateStage | undefined;
  let close: (() => Promise<void>) | undefined;
  try {
    const [migrations, repository, postgresModule] = await Promise.all([
      import("./migration-context"),
      import("./repo"),
      import("postgres"),
    ]);
    const ownerSql = postgresModule.default(databaseUrl, { max: 1, onnotice: () => {} });
    close = () => ownerSql.end({ timeout: 5 });
    await runRestoreSchemaGate({
      inspectSchemaPosture: () => migrations.inspectSchemaPostureWithExecutor(ownerSql),
      async migrateRestore() {
        await migrations.migrateWithExecutor({ kind: "restore" }, ownerSql);
      },
      inspectStructure: () => repository.inspectRestoreSchemaStructure(ownerSql),
    });
  } catch (error) {
    failure = fixedStage(error);
  }

  if (close) {
    try {
      await close();
    } catch {
      failure ??= "cleanup";
    }
  }
  if (failure) throw new RestoreSchemaGateError(failure);
}
