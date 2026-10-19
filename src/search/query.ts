/**
 * Query normalization for the repository search index (#251). The FTS5 query
 * language is powerful (operators, `NEAR`, prefixes, column filters) and its
 * syntax errors reject a statement, so nothing a reader types is ever passed
 * through: each whitespace-separated term is reduced to letters/digits and
 * quoted, and terms shorter than the trigram token length are dropped.
 */

/** Trigram FTS5 cannot index or match fewer than three characters. */
export const MIN_TERM_LENGTH = 3;
/** The longest accepted `q`; the shell's input also caps at this. */
export const MAX_QUERY_LENGTH = 200;
/** Terms longer than this are truncated before matching. */
export const MAX_TERM_LENGTH = 64;
/** At most this many terms survive one query. */
export const MAX_TERMS = 16;

// Everything that is not a letter or digit is a separator. Unicode letters and
// digits survive, so non-Latin queries still match.
const NON_WORD = /[^\p{L}\p{N}]+/gu;

/**
 * Turn free text into an FTS5 MATCH expression, or null when nothing usable
 * remains. Every term is a quoted prefix-free trigram phrase joined by implicit
 * AND; quotes and operators in the input become separators.
 */
export function neutralizeQuery(raw: string): string | null {
  const terms: string[] = [];
  for (const term of raw.split(NON_WORD)) {
    if (term.length < MIN_TERM_LENGTH) continue;
    terms.push(term.slice(0, MAX_TERM_LENGTH));
    if (terms.length === MAX_TERMS) break;
  }
  return terms.length === 0 ? null : terms.map(term => `"${term}"`).join(" ");
}
