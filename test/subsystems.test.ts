// W2: the inventory cannot rot — every src/ top-level module needs a row, every cited path
// must exist. Pure filesystem; runs identically locally and in CI.
import { describe, expect, test } from "bun:test";
import { checkSubsystems } from "../scripts/check-subsystems";

describe("subsystem inventory coverage", () => {
  test("the committed doc covers the committed tree", () => {
    const res = checkSubsystems(process.cwd());
    expect(res.problems).toEqual([]);
    expect(res.ok).toBe(true);
  });

  test("a module missing from the doc is reported", async () => {
    const tmp = `${process.cwd()}/node_modules/.subsys-fixture`;
    const { mkdirSync, rmSync, writeFileSync, cpSync } = await import("node:fs");
    rmSync(tmp, { recursive: true, force: true });
    mkdirSync(`${tmp}/src/rocketry`, { recursive: true });
    mkdirSync(`${tmp}/docs`, { recursive: true });
    cpSync(`${process.cwd()}/docs/SUBSYSTEMS.md`, `${tmp}/docs/SUBSYSTEMS.md`);
    cpSync(`${process.cwd()}/src`, `${tmp}/src`, { recursive: true });
    writeFileSync(`${tmp}/src/rocketry/launch.ts`, "export {};\n");
    try {
      const res = checkSubsystems(tmp);
      expect(res.ok).toBe(false);
      expect(res.problems.join("\n")).toContain("src/rocketry");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
