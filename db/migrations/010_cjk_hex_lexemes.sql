-- CJK bigrams as ASCII hex lexemes (install CI incident 2026-06-12): Postgres's text
-- search parser classifies word characters through the platform libc, and macOS 14's
-- iswalpha drops Han characters even under en_US.UTF-8 + UTF8 — to_tsvector('english',
-- '招商 商银 银行') returned ZERO lexemes on the brew-PG17 CI runner while identical
-- settings work on newer macOS and glibc. Han-character lexemes are therefore not
-- portable. cjk_fold() now emits each bigram as 'zh' + 4 hex digits per codepoint
-- ("招商银行" → " zh62db5546 zh554694f6 zh94f6884c "), which every parser on every
-- platform tokenizes identically. Must stay in lockstep with cjkFold() in
-- src/util/cjk.ts (parity-tested in m8).

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
        out_parts := out_parts || (' zh' || lpad(to_hex(ascii(seg)), 4, '0') || ' ');
      else
        grams := '{}';
        for i in 1..n - 1 loop
          grams := grams || ('zh' || lpad(to_hex(ascii(substr(seg, i, 1))), 4, '0')
                                  || lpad(to_hex(ascii(substr(seg, i + 1, 1))), 4, '0'));
        end loop;
        out_parts := out_parts || (' ' || array_to_string(grams, ' ') || ' ');
      end if;
    else
      out_parts := out_parts || seg;
    end if;
  end loop;
  return array_to_string(out_parts, '');
end $$;

-- Rebuild the generated column through the new fold; the table rewrite backfills all rows.
alter table chunks drop column tsv;
alter table chunks add column tsv tsvector
  generated always as (to_tsvector('english', cjk_fold(text))) stored;
create index chunks_tsv_idx on chunks using gin (tsv);
