-- CJK-aware FTS (DECISIONS.md 2026-06-11): the 'english' tokenizer treats an unspaced Han
-- run as a single token, so Chinese text was unsearchable lexically (bilingual eval: 39/40
-- Chinese queries had zero fts candidates). cjk_fold() rewrites every Han run into
-- overlapping bigrams ("招商银行" → "招商 商银 银行"), the standard CJK trick for
-- segmentation-free engines; non-CJK text passes through untouched, so English indexing is
-- byte-identical. Must stay in lockstep with cjkFold() in src/util/cjk.ts (parity-tested).

create or replace function cjk_fold(t text) returns text
language plpgsql immutable parallel safe as $$
declare
  seg text;
  grams text[];
  out_parts text[] := '{}';
  n int;
  i int;
begin
  if t is null or t = '' then return t; end if;
  for seg in
    select (regexp_matches(t, '([㐀-䶿一-鿿]+|[^㐀-䶿一-鿿]+)', 'g'))[1]
  loop
    if seg ~ '[㐀-䶿一-鿿]' then
      n := length(seg);
      if n = 1 then
        out_parts := out_parts || (' ' || seg || ' ');
      else
        grams := '{}';
        for i in 1..n - 1 loop
          grams := grams || substr(seg, i, 2);
        end loop;
        out_parts := out_parts || (' ' || array_to_string(grams, ' ') || ' ');
      end if;
    else
      out_parts := out_parts || seg;
    end if;
  end loop;
  return array_to_string(out_parts, '');
end $$;

-- Rebuild the generated column through cjk_fold; the table rewrite backfills all rows.
alter table chunks drop column tsv;
alter table chunks add column tsv tsvector
  generated always as (to_tsvector('english', cjk_fold(text))) stored;
create index chunks_tsv_idx on chunks using gin (tsv);
