#!/usr/bin/env bun

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  validatePromotionEndpoints,
  validateRecoveryEndpoints,
} from "../src/ops/recovery-endpoints";
import { GUARDED_RECOVERY_SOURCE_DATABASE, parseLocalPostgresUrl } from "../src/util/postgres-url";

type RecoveryCommand =
  | { readonly mode: "drill" }
  | { readonly mode: "pitr"; readonly time: string }
  | { readonly mode: "promote" };

export interface RecoveryInvocation {
  readonly argv: string[];
  readonly cwd: string;
  readonly env: Record<string, string>;
}

export interface RecoveryInvocationOptions {
  readonly repoRoot?: string;
  readonly callerEnv?: Readonly<NodeJS.ProcessEnv>;
}

const DEFAULT_DATABASE_URL = "postgres://minime:minime@localhost:5432/minime";
const REPO_FORWARD_KEYS = [
  "RESTIC_REPOSITORY",
  "RESTIC_PASSWORD_FILE",
  "B2_ACCOUNT_ID",
  "B2_ACCOUNT_KEY",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_REGION",
  "AWS_DEFAULT_REGION",
] as const;
const CALLER_ONLY_FORWARD_KEYS = ["PGBIN", "RESTIC_BIN", "BUN_INSTALL", "TMPDIR"] as const;

class RecoveryOperationError extends Error {
  constructor(
    readonly kind: "usage" | "configuration" | "spawn",
    readonly exitCode: number,
  ) {
    super(`recovery_operation_${kind}`);
  }
}

function validPitrTime(value: string | undefined): value is string {
  if (!value || value.length > 128 || value !== value.trim()) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return false;
  }
  return true;
}

export function parseRecoveryCommand(argv: readonly string[]): RecoveryCommand {
  if (argv.length === 1 && argv[0] === "drill") return { mode: "drill" };
  if (argv.length === 1 && argv[0] === "promote") return { mode: "promote" };
  if (argv.length === 2 && argv[0] === "pitr" && validPitrTime(argv[1])) {
    return { mode: "pitr", time: argv[1] };
  }
  throw new RecoveryOperationError("usage", 2);
}

function parseDotenvData(text: string): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (const rawLine of text.split("\n")) {
    let line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("export ")) line = line.slice(7).trim();
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = line.slice(separator + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    } else {
      const comment = value.search(/\s#/);
      if (comment >= 0) value = value.slice(0, comment).trimEnd();
    }
    parsed[key] = value;
  }
  return parsed;
}

function repoEnvironment(repoRoot: string): Record<string, string> {
  const envFile = join(repoRoot, ".env");
  return existsSync(envFile) ? parseDotenvData(readFileSync(envFile, "utf8")) : {};
}

function selectedValue(
  key: string,
  caller: Readonly<NodeJS.ProcessEnv>,
  fromFile: Readonly<Record<string, string>>,
): string | undefined {
  return Object.prototype.hasOwnProperty.call(caller, key) ? caller[key] : fromFile[key];
}

function withDatabase(raw: string, database: string): string {
  const url = new URL(raw);
  url.pathname = `/${database}`;
  return url.toString();
}

function fixedEndpoints(raw: string, command: RecoveryCommand) {
  const expected = command.mode === "promote" ? "minime" : GUARDED_RECOVERY_SOURCE_DATABASE;
  const source = parseLocalPostgresUrl(raw, expected);
  const endpoints = {
    source: raw,
    admin: withDatabase(source.url.toString(), "postgres"),
    drill: withDatabase(source.url.toString(), "minime_drill"),
    live: withDatabase(source.url.toString(), "minime"),
    restore: withDatabase(source.url.toString(), "minime_restore"),
  };
  if (command.mode === "promote") validatePromotionEndpoints(endpoints);
  else validateRecoveryEndpoints(endpoints);
  return endpoints;
}

function forwardedEnvironment(
  caller: Readonly<NodeJS.ProcessEnv>,
  fromFile: Readonly<Record<string, string>>,
): Record<string, string> {
  const forwarded: Record<string, string> = {};
  for (const key of REPO_FORWARD_KEYS) {
    const value = selectedValue(key, caller, fromFile);
    if (value !== undefined) forwarded[key] = value;
  }
  for (const key of CALLER_ONLY_FORWARD_KEYS) {
    const value = caller[key];
    if (value !== undefined) forwarded[key] = value;
  }
  return forwarded;
}

export function buildRecoveryInvocation(
  argv: readonly string[],
  options: RecoveryInvocationOptions = {},
): RecoveryInvocation {
  const command = parseRecoveryCommand(argv);
  const repoRoot = options.repoRoot ?? resolve(import.meta.dir, "..");
  const caller = options.callerEnv ?? process.env;
  try {
    const fromFile = repoEnvironment(repoRoot);
    const databaseUrl = selectedValue("DATABASE_URL", caller, fromFile) ?? DEFAULT_DATABASE_URL;
    const endpoints = fixedEndpoints(databaseUrl, command);
    const env: Record<string, string> = {
      DATABASE_URL: endpoints.source,
      ADMIN_URL: endpoints.admin,
      DRILL_URL: endpoints.drill,
      LIVE_URL: endpoints.live,
      RESTORE_URL: endpoints.restore,
      ...forwardedEnvironment(caller, fromFile),
    };
    if (command.mode === "drill") env.MINIME_RESTORE_REQUIRE_RESTIC = "1";
    if (command.mode === "pitr") env.TIME = command.time;
    const script =
      command.mode === "drill"
        ? "restore-drill.sh"
        : command.mode === "pitr"
          ? "restore-pitr.sh"
          : "promote-restore.sh";
    return { argv: [join(repoRoot, "scripts", script)], cwd: repoRoot, env };
  } catch {
    throw new RecoveryOperationError("configuration", 1);
  }
}

const FORWARDED_SIGNALS = ["SIGHUP", "SIGINT", "SIGTERM"] as const;

async function spawnRecoveryChild(invocation: RecoveryInvocation): Promise<number> {
  const child = Bun.spawn(invocation.argv, {
    cwd: invocation.cwd,
    env: invocation.env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const handlers = FORWARDED_SIGNALS.map((signal) => {
    const handler = () => {
      try {
        child.kill(signal);
      } catch {
        // The child may have completed between signal delivery and forwarding.
      }
    };
    process.on(signal, handler);
    return { signal, handler };
  });
  try {
    return await child.exited;
  } finally {
    for (const { signal, handler } of handlers) process.off(signal, handler);
  }
}

export async function runRecoveryOperation(
  argv: readonly string[],
  options: RecoveryInvocationOptions = {},
): Promise<number> {
  return spawnRecoveryChild(buildRecoveryInvocation(argv, options));
}

export async function recoveryMain(argv: readonly string[]): Promise<number> {
  try {
    return await runRecoveryOperation(argv);
  } catch (error) {
    const failure =
      error instanceof RecoveryOperationError ? error : new RecoveryOperationError("spawn", 1);
    console.error(`recovery operation failed (${failure.kind})`);
    return failure.exitCode;
  }
}

if (import.meta.main) {
  process.exit(await recoveryMain(process.argv.slice(2)));
}
