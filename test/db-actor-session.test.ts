import { describe, expect, test } from "bun:test";
import {
  db,
  hasDbTransaction,
  isAdminDbScope,
  reserveDb,
  withAdminDbScope,
  withDbTransaction,
  withReservedDb,
} from "../src/db/client";
import { withActorDbSession } from "../src/db/repo";

describe("actor-scoped database sessions", () => {
  test("trusted maintenance scope is explicit, nested, and cleared", async () => {
    expect(isAdminDbScope()).toBe(false);
    await withAdminDbScope(async () => {
      expect(isAdminDbScope()).toBe(true);
      await withAdminDbScope(async () => expect(isAdminDbScope()).toBe(true));
    });
    expect(isAdminDbScope()).toBe(false);
  });
  test("nested transactions reuse one executor and actor state is local", async () => {
    let outer: unknown;
    let inner: unknown;
    await withActorDbSession("agent:scope", async () => {
      await withDbTransaction(async (tx) => {
        outer = tx;
        await withDbTransaction(async (nested) => {
          inner = nested;
        });
      });
      const [row] = await db()`select current_setting('minime.actor', true) as actor`;
      expect(row?.actor).toBe("agent:scope");
    });
    expect(inner).toBe(outer);
    expect(hasDbTransaction()).toBe(false);
  });

  test("actor state is cleared after a failed request", async () => {
    await expect(
      withActorDbSession("agent:failure", async () => {
        const [row] = await db()`select current_setting('minime.actor', true) as actor`;
        expect(row?.actor).toBe("agent:failure");
        throw new Error("synthetic_actor_failure");
      }),
    ).rejects.toThrow("synthetic_actor_failure");
    expect(hasDbTransaction()).toBe(false);
  });

  test("reserved connection release is idempotent and independent of actor transactions", async () => {
    const reservation = await reserveDb();
    await reservation.release();
    await reservation.release();
    await withActorDbSession("agent:reserved", async () => {
      await withReservedDb(async (connection) => {
        const [row] =
          await connection`select nullif(current_setting('minime.actor', true), '') as actor`;
        expect(row?.actor).toBeNull();
      });
    });
  });
});
