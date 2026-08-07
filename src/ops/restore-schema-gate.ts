export type RestoreSchemaGateStage =
  | "target_boundary"
  | "ledger"
  | "migration"
  | "structure"
  | "cleanup";

export class RestoreSchemaGateError extends Error {
  constructor(readonly stage: RestoreSchemaGateStage) {
    super(`restore_schema_gate_${stage}`);
  }
}

export interface RestoreMigrationPosture {
  readonly missing: readonly string[];
  readonly unexpected: readonly string[];
}

export interface RestoreSchemaStructure {
  readonly extensions: boolean;
  readonly coreRelations: boolean;
  readonly migrationLedger: boolean;
  readonly appendOnlyAudit: boolean;
  readonly tierBoundary: boolean;
  readonly inboxIdentity: boolean;
}

export interface RestoreSchemaGateDependencies {
  inspectSchemaPosture(): Promise<RestoreMigrationPosture>;
  migrateRestore(): Promise<void>;
  inspectStructure(): Promise<RestoreSchemaStructure>;
}

function assertNoUnexpectedLedger(posture: RestoreMigrationPosture): void {
  if (posture.unexpected.length !== 0) throw new RestoreSchemaGateError("ledger");
}

function assertExactLedger(posture: RestoreMigrationPosture): void {
  if (posture.missing.length !== 0 || posture.unexpected.length !== 0) {
    throw new RestoreSchemaGateError("ledger");
  }
}

async function inspectLedger(
  dependencies: RestoreSchemaGateDependencies,
): Promise<RestoreMigrationPosture> {
  try {
    return await dependencies.inspectSchemaPosture();
  } catch {
    throw new RestoreSchemaGateError("ledger");
  }
}

async function assertStructure(dependencies: RestoreSchemaGateDependencies): Promise<void> {
  let structure: RestoreSchemaStructure;
  try {
    structure = await dependencies.inspectStructure();
  } catch {
    throw new RestoreSchemaGateError("structure");
  }
  if (
    !structure.extensions ||
    !structure.coreRelations ||
    !structure.migrationLedger ||
    !structure.appendOnlyAudit ||
    !structure.tierBoundary ||
    !structure.inboxIdentity
  ) {
    throw new RestoreSchemaGateError("structure");
  }
}

export async function runRestoreSchemaGate(
  dependencies: RestoreSchemaGateDependencies,
): Promise<void> {
  // The caller owns dump/manifest/hash/count verification before reaching this schema-only gate.
  assertNoUnexpectedLedger(await inspectLedger(dependencies));
  try {
    await dependencies.migrateRestore();
  } catch {
    throw new RestoreSchemaGateError("migration");
  }
  assertExactLedger(await inspectLedger(dependencies));
  await assertStructure(dependencies);
}
