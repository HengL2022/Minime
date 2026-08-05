import { describe, expect, test } from "bun:test";
import { validateRecoveryEndpoints } from "../src/ops/recovery-endpoints";

const endpoints = {
  source: "postgres://minime:fictional@localhost:5432/minime",
  admin: "postgres://minime:fictional@127.0.0.1:5432/postgres",
  drill: "postgres://minime:fictional@localhost:5432/minime_drill",
  live: "postgres://minime:fictional@127.0.0.1:5432/minime",
  restore: "postgres://minime:fictional@localhost:5432/minime_restore",
};

describe("recovery endpoint boundary", () => {
  test("accepts the fixed local recovery topology and guarded test sources", () => {
    expect(() => validateRecoveryEndpoints(endpoints)).not.toThrow();
    expect(() =>
      validateRecoveryEndpoints({
        ...endpoints,
        source: "postgres://minime:fictional@localhost:5432/minime_test_restoree2e_123",
      }),
    ).not.toThrow();
  });

  test.each([
    ["drill replay into live", { drill: endpoints.live }],
    ["restore replay into live", { restore: endpoints.live }],
    ["admin pointed at live", { admin: endpoints.live }],
    ["remote replay target", { drill: endpoints.drill.replace("localhost", "db.example.test") }],
    ["second local cluster", { restore: endpoints.restore.replace(":5432", ":5433") }],
    ["query override", { live: `${endpoints.live}?options=-csearch_path%3Dother` }],
  ])("rejects %s", (_label, override) => {
    expect(() => validateRecoveryEndpoints({ ...endpoints, ...override })).toThrow(
      "recovery_endpoint_invalid",
    );
  });
});
