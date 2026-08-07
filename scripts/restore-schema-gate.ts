#!/usr/bin/env bun

import { runDatabaseRestoreSchemaGate } from "../src/db/restore-schema-gate";
import {
  RestoreSchemaGateError,
  type RestoreSchemaGateStage,
} from "../src/ops/restore-schema-gate";

function fixedStage(error: unknown): RestoreSchemaGateStage {
  return error instanceof RestoreSchemaGateError ? error.stage : "migration";
}

async function main(): Promise<void> {
  try {
    if (process.argv.length !== 2) throw new RestoreSchemaGateError("target_boundary");
    await runDatabaseRestoreSchemaGate(await Bun.stdin.text());
  } catch (error) {
    console.error(`restore schema gate failed (${fixedStage(error)})`);
    process.exitCode = 1;
    return;
  }
  console.log("restore schema gate passed");
}

await main();
