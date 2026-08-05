#!/usr/bin/env bun
import { randomUUID } from "node:crypto";
import {
  constants,
  closeSync,
  fchmodSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import {
  LibpqServiceError,
  parsePostgresUri,
  registerEphemeralCleanup,
  renderLibpqService,
} from "../src/util/libpq-service";

let afterBridgeRegisterForTest: ((path: string) => void) | undefined;
let afterBridgePublishForTest: ((path: string) => void) | undefined;
export function __setAfterBridgeRegisterForTest(hook: ((path: string) => void) | undefined): void {
  afterBridgeRegisterForTest = hook;
}
export function __setAfterBridgePublishForTest(hook: ((path: string) => void) | undefined): void {
  afterBridgePublishForTest = hook;
}
if (process.env.H3_SIGNAL_AFTER_BRIDGE_REGISTER === "1") {
  afterBridgeRegisterForTest = () => process.kill(process.pid, "SIGTERM");
}

function validateOutputParent(outputPath: string): string | undefined {
  const parent = dirname(outputPath);
  if (!isAbsolute(parent)) return undefined;
  try {
    let component = parent;
    for (;;) {
      const entry = lstatSync(component, { throwIfNoEntry: false });
      if (!entry || !entry.isDirectory() || entry.isSymbolicLink()) return undefined;
      const next = dirname(component);
      if (next === component) break;
      component = next;
    }
    const physicalParent = realpathSync(parent);
    const owner = statSync(physicalParent);
    if ((owner.mode & 0o777) !== 0o700) return undefined;
    if (typeof process.getuid === "function" && owner.uid !== process.getuid()) return undefined;
    return physicalParent;
  } catch {
    return undefined;
  }
}

const output = process.argv[2];
if (!output || process.argv.length !== 3 || !isAbsolute(output) || process.stdin.isTTY) {
  console.error("ERROR: could not create private PostgreSQL service file (usage).");
  process.exit(2);
}
const outputParent = validateOutputParent(output);
if (!outputParent) {
  console.error("ERROR: could not create private PostgreSQL service file (output_parent).");
  process.exit(2);
}

try {
  const raw = await Bun.stdin.text();
  if (!raw || raw.endsWith("\n") || raw.endsWith("\r")) throw new LibpqServiceError("syntax");
  const rendered = renderLibpqService(parsePostgresUri(raw));
  const temp = join(outputParent, `.${basename(output)}.${randomUUID()}.tmp`);
  const flags =
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0);
  let fd = -1;
  let tempReserved = false;
  let outputOwned = false;
  let unregister: (() => void) | undefined;
  let unregisterOutput: (() => void) | undefined;
  let removeOutput: (() => boolean) | undefined;
  try {
    fd = openSync(temp, flags, 0o600);
    tempReserved = true;
    unregister = registerEphemeralCleanup(temp, () => {
      try {
        const entry = lstatSync(temp);
        if (!entry.isFile() || entry.isSymbolicLink()) return false;
        unlinkSync(temp);
        return !lstatSync(temp, { throwIfNoEntry: false });
      } catch (error: unknown) {
        return (error as NodeJS.ErrnoException).code === "ENOENT";
      }
    });
    afterBridgeRegisterForTest?.(temp);
    await Bun.sleep(0);
    writeFileSync(fd, rendered, "utf8");
    fchmodSync(fd, 0o600);
    fsyncSync(fd);
    closeSync(fd);
    fd = -1;
    linkSync(temp, output);
    outputOwned = true;
    removeOutput = () => {
      try {
        const entry = lstatSync(output);
        if (!entry.isFile() || entry.isSymbolicLink()) return false;
        unlinkSync(output);
        return !lstatSync(output, { throwIfNoEntry: false });
      } catch (error: unknown) {
        return (error as NodeJS.ErrnoException).code === "ENOENT";
      }
    };
    unregisterOutput = registerEphemeralCleanup(output, removeOutput);
    afterBridgePublishForTest?.(output);
    await Bun.sleep(0);
    unlinkSync(temp);
    unregister();
    unregisterOutput();
  } catch (error) {
    if (fd !== -1) {
      try {
        closeSync(fd);
      } catch {
        /* fixed cleanup path */
      }
    }
    if (tempReserved) {
      try {
        unlinkSync(temp);
      } catch {
        /* missing is already clean */
      }
    }
    unregister?.();
    if (outputOwned && removeOutput?.()) unregisterOutput?.();
    throw error;
  }
} catch (error) {
  const rule = error instanceof LibpqServiceError ? error.rule : "filesystem";
  console.error(`ERROR: could not create private PostgreSQL service file (${rule}).`);
  process.exit(1);
}
