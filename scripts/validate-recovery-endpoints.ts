#!/usr/bin/env bun

import { validateRecoveryEndpoints } from "../src/ops/recovery-endpoints";

try {
  const fields = (await Bun.stdin.text()).split("\0");
  if (fields.length !== 6 || fields[5] !== "") throw new Error("recovery_endpoint_invalid");
  validateRecoveryEndpoints({
    source: fields[0]!,
    admin: fields[1]!,
    drill: fields[2]!,
    live: fields[3]!,
    restore: fields[4]!,
  });
} catch {
  console.error("recovery endpoint validation failed");
  process.exit(1);
}
