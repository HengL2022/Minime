// CJK helpers. cjkFold must produce byte-identical output to the SQL cjk_fold()
// (db/migrations/010_cjk_hex_lexemes.sql) — index side uses SQL, query side uses this;
// the m8 parity test keeps them in lockstep.
//
// Why HEX lexemes (zh + 4 hex digits per char): Postgres's text-search parser classifies
// word characters through the platform libc (iswalpha under the database ctype), and
// macOS 14's libc drops Han characters even under en_US.UTF-8 — to_tsvector emitted ZERO
// lexemes for Chinese on the brew-PG17 CI runner while identical settings work on newer
// macOS and glibc (install CI incident 2026-06-12). Pure-ASCII lexemes are classified
// identically on every platform, forever. "招商银行" → " zh62db5546 zh554694f6 zh94f6884c ".

const CJK_RUN = /[㐀-䶿一-鿿]+/gu;
export const CJK_CHAR = /[㐀-䶿一-鿿]/gu;

const hex4 = (c: string) => c.codePointAt(0)!.toString(16).padStart(4, "0");

// Han runs → overlapping bigrams as ASCII hex lexemes; single char stays a unigram
// (zh + one codepoint). Non-CJK text passes through untouched.
export function cjkFold(t: string): string {
  return t.replace(CJK_RUN, (run) => {
    // BMP Han chars are single UTF-16 units, so indexing by code unit is per-character
    if (run.length === 1) return ` zh${hex4(run)} `;
    const grams: string[] = [];
    for (let i = 0; i < run.length - 1; i++) grams.push(`zh${hex4(run[i]!)}${hex4(run[i + 1]!)}`);
    return ` ${grams.join(" ")} `;
  });
}

// The pre-hex fold ("招商银行" → " 招商 商银 银行 ") — used ONLY by the mock embedding
// (src/llm/mock.ts), whose committed eval floors depend on byte-stable token values.
// Never use this for FTS or title matching; the platform-safe form is cjkFold.
export function cjkFoldRaw(t: string): string {
  return t.replace(CJK_RUN, (run) => {
    if (run.length === 1) return ` ${run} `;
    const grams: string[] = [];
    for (let i = 0; i < run.length - 1; i++) grams.push(run.slice(i, i + 2));
    return ` ${grams.join(" ")} `;
  });
}

/** A folded CJK lexeme (zh + one-or-more 4-hex-digit codepoints)? */
const CJK_HEX = /^zh(?:[0-9a-f]{4})+$/;
export function isCjkToken(token: string): boolean {
  return CJK_HEX.test(token);
}

function decodeCjkToken(token: string): string {
  let out = "";
  for (let i = 2; i < token.length; i += 4)
    out += String.fromCodePoint(Number.parseInt(token.slice(i, i + 4), 16));
  return out;
}

// Han function characters — the CJK analogue of the 'english' stopword list, which knows
// nothing about Chinese. A query token composed ONLY of these (我的, 什么, 时候…) carries
// no content but lexically matches every Chinese doc, drowning cross-language results
// (bilingual eval 2026-06-11: zh→en hit@1 fell 80%→7% without this filter). Query-side
// only; the index keeps everything. Accepts both raw bigrams and folded zh-hex lexemes.
const CJK_STOP = new Set(
  "的一了是我不在有这那他她它们你您么什哪里谁个上中下要会能可以和与就都还也很到从把被让为多少每天年月日时候后前先看做去过来吗呢啊吧没好再又只但如果因所然".split(
    "",
  ),
);

export function isCjkStopToken(token: string): boolean {
  const text = isCjkToken(token) ? decodeCjkToken(token) : token;
  const chars = Array.from(text);
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
