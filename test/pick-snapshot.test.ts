import { describe, expect, test } from "bun:test";

const pick = async (env: Record<string, string | undefined>, input: unknown) => {
  const proc = Bun.spawn([Bun.which("bun")!, "run", "scripts/pick-snapshot.ts"], {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  proc.stdin.write(JSON.stringify(input));
  proc.stdin.end();
  return {
    status: await proc.exited,
    stdout: await new Response(proc.stdout).text(),
    stderr: await new Response(proc.stderr).text(),
  };
};

describe("pick-snapshot", () => {
  const snapshots = [
    { id: "old", time: "2026-08-01T00:00:00Z", tags: ["db-snap"] },
    { id: "dream-new", time: "2026-08-03T00:00:00Z", tags: ["dream"] },
    { id: "other-new", time: "2026-08-04T00:00:00Z", tags: ["other"] },
  ];

  test("latest mode selects newest db-snap or dream snapshot only", async () => {
    const result = await pick({ LATEST: "1" }, snapshots);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("dream-new\t2026-08-03T00:00:00Z");
  });

  test("TIME mode remains inclusive and refuses snapshots after the cutoff", async () => {
    const result = await pick({ TIME: "2026-08-02 00:00" }, snapshots);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("old\t2026-08-01T00:00:00Z");
  });

  test("requires exactly one selection mode", async () => {
    const result = await pick({}, snapshots);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("selection mode");
  });

  test("rejects a non-array restic payload with a fixed error", async () => {
    const result = await pick({ LATEST: "1" }, { snapshots });
    expect(result.status).toBe(2);
    expect(result.stderr).toBe("pick-snapshot: invalid restic JSON\n");
  });

  test("skips eligible-looking entries with invalid ids or times", async () => {
    const result = await pick({ LATEST: "1" }, [
      { id: "-option", time: "2026-08-09T00:00:00Z", tags: ["db-snap"] },
      { id: "nan-time", time: "not-a-time", tags: ["dream"] },
      { id: "safe-id", time: "2026-08-02T00:00:00Z", tags: ["db-snap"] },
    ]);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("safe-id\t2026-08-02T00:00:00Z\n");
  });

  test("does not select an invalid-only payload", async () => {
    const result = await pick({ LATEST: "1" }, [
      { id: "-option", time: "not-a-time", tags: ["db-snap"] },
    ]);
    expect(result.status).toBe(3);
    expect(result.stderr).toBe("pick-snapshot: no eligible db-snap/dream snapshot\n");
  });
});
