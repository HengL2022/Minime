// W1 extractor re-validation (improve-w1-extract-validate.md). Offline; mock verdicts.
import { beforeAll, describe, expect, test } from "bun:test";
import { insertReviewItem } from "../src/db/repo";
import { expectSqlReject, resetDb, testSql } from "./helpers";

describe("migration 017", () => {
  beforeAll(async () => {
    await resetDb();
  });

  test("edge_validations exists with verdict CHECK; review kind extract_suspect accepted", async () => {
    const [e] =
      await testSql`insert into edges (src_type, src_id, rel, dst_type, dst_id, extracted_by)
      values ('page', gen_random_uuid(), 'mentions', 'person', gen_random_uuid(), 'system:extract') returning id`;
    await testSql`insert into edge_validations (edge_id, verdict, model, rule_key)
      values (${e!.id}, 'confirm', 'mock', 'mentions@0.8')`;
    await expectSqlReject(
      testSql`insert into edge_validations (edge_id, verdict, model, rule_key)
        values (${e!.id}, 'maybe', 'mock', 'mentions@0.8')`,
      /verdict/,
    );
    const { id } = await insertReviewItem("extract_suspect", { edge_id: e!.id });
    expect(id).toBeTruthy();
    await expectSqlReject(
      testSql`insert into review_queue (kind, payload) values ('bogus_kind', '{}')`,
      /review_queue_kind_check/,
    );
  });
});
