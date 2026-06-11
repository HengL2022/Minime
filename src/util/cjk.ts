// CJK helpers. cjkFold must produce byte-identical output to the SQL cjk_fold()
// (db/migrations/009_cjk_fts.sql) — index side uses SQL, query side uses this; the
// m8 parity test keeps them in lockstep.

const CJK_RUN = /[㐀-䶿一-鿿]+/gu;
export const CJK_CHAR = /[㐀-䶿一-鿿]/gu;

// Han runs → overlapping bigrams: "招商银行" → " 招商 商银 银行 "; single char stays
// a unigram. Non-CJK text passes through untouched.
export function cjkFold(t: string): string {
  return t.replace(CJK_RUN, (run) => {
    if (run.length === 1) return ` ${run} `;
    const grams: string[] = [];
    for (let i = 0; i < run.length - 1; i++) grams.push(run.slice(i, i + 2));
    return ` ${grams.join(" ")} `;
  });
}

// Han function characters — the CJK analogue of the 'english' stopword list, which knows
// nothing about Chinese. A query token composed ONLY of these (我的, 什么, 时候…) carries
// no content but lexically matches every Chinese doc, drowning cross-language results
// (bilingual eval 2026-06-11: zh→en hit@1 fell 80%→7% without this filter). Query-side
// only; the index keeps everything.
const CJK_STOP = new Set(
  "的一了是我不在有这那他她它们你您么什哪里谁个上中下要会能可以和与就都还也很到从把被让为多少每天年月日时候后前先看做去过来吗呢啊吧没好再又只但如果因所然".split(
    "",
  ),
);

export function isCjkStopToken(token: string): boolean {
  const chars = Array.from(token);
  return chars.length > 0 && chars.every((c) => CJK_STOP.has(c));
}

// Approximate token count for chunk sizing: whitespace words, except each Han char
// counts as one token (Chinese has no spaces, so word-counting undercounts it ~50x).
export function tokenCount(s: string): number {
  let n = 0;
  for (const w of s.split(/\s+/)) {
    if (!w) continue;
    n += Math.max(1, w.match(CJK_CHAR)?.length ?? 0);
  }
  return n;
}
