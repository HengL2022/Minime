#!/usr/bin/env bun

import {
  validatePromotionEndpoints,
  validateRecoveryEndpoints,
} from "../src/ops/recovery-endpoints";

try {
  const mode = process.argv[2] ?? "recovery";
  if (mode !== "recovery" && mode !== "promote") throw new Error("recovery_endpoint_invalid");
  const fields = (await Bun.stdin.text()).split("\0");
  if (fields.length !== 6 || fields[5] !== "") throw new Error("recovery_endpoint_invalid");
  const endpoints = {
    source: fields[0]!,
    admin: fields[1]!,
    drill: fields[2]!,
    live: fields[3]!,
    restore: fields[4]!,
  };
  if (mode === "promote") validatePromotionEndpoints(endpoints);
  else validateRecoveryEndpoints(endpoints);
} catch {
  console.error("recovery endpoint validation failed");
  process.exit(1);
}
