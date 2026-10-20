import type { PageSection } from "@/ingest/sections";
import type { SearchHit, SearchIndex } from "./index";

/**
 * The Cloudflare D1 binding surface the search index uses. Declared here rather
 * than pulled from @cloudflare/workers-types so the module can be exercised by
 * a test double in Node as well as workerd's real D1.
 */
export interface SearchD1Result<T> {
  results: T[];
}

export interface SearchD1Statement {
  bind(...values: unknown[]): SearchD1Statement;
  all<T = unknown>(): Promise<SearchD1Result<T>>;
  run(): Promise<unknown>;
}

export interface SearchD1 {
  prepare(sql: string): SearchD1Statement;
  batch(statements: readonly SearchD1Statement[]): Promise<unknown[]>;
  exec(sql: string): Promise<unknown>;
}

/**
 * Code points of the repository key (#294): Supplementary Private Use Area-A,
 * U+F0000 to U+FFFFD. Indexed titles and bodies never contain them (they are
 * stripped at `putBlob`) and a query term never does (it is letters and digits
 * only), so the key's trigrams occur in the key column alone.
 */
const KEY_BASE = 0xf0000;
const KEY_RADIX = 65_534;
const KEY_DIGITS = 4;
const KEY_CHARACTERS = /[\u{F0000}-\u{FFFFF}]/gu;

/** The repository's key in SQL: four base-65534 digits of `column`, most significant first. */
function keySql(column: string): string {
  const digits = Array.from({ length: KEY_DIGITS }, (_, index) => {
    const place = KEY_RADIX ** (KEY_DIGITS - 1 - index);
    return `${KEY_BASE} + (${place === 1 ? column : `${column} / ${place}`}) % ${KEY_RADIX}`;
  });
  return `char(${digits.join(", ")})`;
}

/** The same key as `keySql`, for the query. Exact for every safe integer. */
export function repoSearchKey(repoId: number): string {
  let rest = BigInt(repoId);
  const digits: string[] = [];
  for (let index = 0; index < KEY_DIGITS; index += 1) {
    digits.unshift(String.fromCodePoint(KEY_BASE + Number(rest % BigInt(KEY_RADIX))));
    rest /= BigInt(KEY_RADIX);
  }
  return digits.join("");
}

/** Text as it is indexed: without the code points the repository key is made of. */
function searchable(text: string): string {
  return text.replace(KEY_CHARACTERS, "");
}

/**
 * External-content FTS5 over a plain `sections` table, so a section's text is
 * stored once. The triggers keep the FTS index in step; `DELETE` then `INSERT`
 * per blob makes re-indexing a changed page idempotent. `rowid` is the join
 * key: the primary key is composite, so the table is still a rowid table.
 * `trigram` is the tokenizer: code identifiers and partial words match, and a
 * query term must be at least three characters.
 *
 * The index is partitioned by repository inside FTS5 itself (#294): its first
 * column, `rk`, holds the repository key (computed by the `sections_keyed`
 * view, the external content), and every query matches `rk` as well as its
 * terms. A query then walks the key's doclist, which holds only that
 * repository's rows, and reads every other doclist only at those rows: its
 * cost does not depend on what other repositories have indexed.
 *
 * Forward-only migration from #251's `sections_fts` (title and body only):
 * the first run in a database creates the keyed index, swaps the triggers,
 * rebuilds the index from `sections` and drops the old one, all in the one
 * batch (a transaction). Every later run is a no-op.
 */
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS sections (
    repo_id INTEGER NOT NULL,
    blob_sha TEXT NOT NULL,
    slug TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    PRIMARY KEY (repo_id, blob_sha, slug)
  )`,
  `CREATE VIEW IF NOT EXISTS sections_keyed AS SELECT rowid AS id, ${keySql("repo_id")} AS rk, title, body FROM sections`,
  `CREATE VIRTUAL TABLE IF NOT EXISTS sections_search USING fts5(
    rk, title, body, content='sections_keyed', content_rowid='id', tokenize='trigram'
  )`,
  "DROP TRIGGER IF EXISTS sections_ai",
  "DROP TRIGGER IF EXISTS sections_ad",
  "DROP TRIGGER IF EXISTS sections_au",
  `CREATE TRIGGER IF NOT EXISTS sections_search_ai AFTER INSERT ON sections BEGIN
    INSERT INTO sections_search(rowid, rk, title, body) VALUES (new.rowid, ${keySql("new.repo_id")}, new.title, new.body);
  END`,
  `CREATE TRIGGER IF NOT EXISTS sections_search_ad AFTER DELETE ON sections BEGIN
    INSERT INTO sections_search(sections_search, rowid, rk, title, body) VALUES ('delete', old.rowid, ${keySql("old.repo_id")}, old.title, old.body);
  END`,
  `CREATE TRIGGER IF NOT EXISTS sections_search_au AFTER UPDATE ON sections BEGIN
    INSERT INTO sections_search(sections_search, rowid, rk, title, body) VALUES ('delete', old.rowid, ${keySql("old.repo_id")}, old.title, old.body);
    INSERT INTO sections_search(rowid, rk, title, body) VALUES (new.rowid, ${keySql("new.repo_id")}, new.title, new.body);
  END`,
  // Only while #251's index still exists: rows indexed there are indexed here, once.
  "INSERT INTO sections_search(sections_search) SELECT 'rebuild' WHERE EXISTS (SELECT 1 FROM sqlite_master WHERE name = 'sections_fts')",
  "DROP TABLE IF EXISTS sections_fts",
];

// D1 batches are single round trips; keep them small enough to stay well under
// the request size limit on a pathologically sectioned page.
const INSERT_CHUNK = 40;

/** Twice the matched runs `highlight()` marks in the title: each adds two characters. */
const TITLE_RUNS = "length(highlight(sections_search, 1, char(2), char(3))) - length(s.title)";

// snippet(): column 2 is `body`; \u0002/\u0003 wrap each matched run so the
// client can build <mark> nodes from text, never HTML. With the trigram
// tokenizer the window counts 3-character tokens, so 64 is about 64 characters
// of context. The rank reads the row alone, never an index-wide statistic
// (bm25's inverse document frequency counts the matches of every repository,
// #294): sections whose title matches more of the query first, then the
// shorter section, which bm25's length normalization also favoured.
// `+s.repo_id` is a second check only: the unary plus keeps the planner from
// driving the query by the sections index, so the scoped MATCH always does.
const SELECT_HITS = `SELECT s.blob_sha AS blob_sha, s.slug AS slug, s.title AS title,
  snippet(sections_search, 2, char(2), char(3), '...', 64) AS snippet
  FROM sections_search JOIN sections s ON s.rowid = sections_search.rowid
  WHERE sections_search MATCH ? AND +s.repo_id = ?
  ORDER BY ${TITLE_RUNS} DESC, length(s.body), s.rowid LIMIT ?`;

/** The repository key, and the reader's terms in the title or body only. */
export function scopedMatch(repoId: number, match: string): string {
  return `rk : "${repoSearchKey(repoId)}" AND {title body} : (${match})`;
}

interface SectionRow {
  blob_sha: string;
  slug: string;
  title: string;
  snippet: string;
}

// One migration promise per database, however many index objects wrap it: the
// serving Worker builds a fresh one per request.
const migrations = new WeakMap<SearchD1, Promise<void>>();

export function d1SearchIndex(db: SearchD1): SearchIndex {
  const migrate = (): Promise<void> => {
    let ready = migrations.get(db);
    if (!ready) {
      ready = (async () => {
        // One round trip. DDL in a batch is fine; `exec` would split the
        // statements on every line and cannot run triggers at all.
        await db.batch(SCHEMA.map(statement => db.prepare(statement)));
      })();
      migrations.set(db, ready);
    }
    return ready;
  };

  return {
    migrate,
    async hasBlob(repoId, blobSha) {
      await migrate();
      const rows = await db.prepare("SELECT 1 FROM sections WHERE repo_id = ? AND blob_sha = ? LIMIT 1").bind(repoId, blobSha).all();
      return rows.results.length > 0;
    },
    async putBlob(repoId, blobSha, sections: readonly PageSection[]) {
      await migrate();
      await db.prepare("DELETE FROM sections WHERE repo_id = ? AND blob_sha = ?").bind(repoId, blobSha).run();
      const insert = "INSERT INTO sections (repo_id, blob_sha, slug, title, body) VALUES (?, ?, ?, ?, ?)";
      for (let start = 0; start < sections.length; start += INSERT_CHUNK) {
        await db.batch(sections.slice(start, start + INSERT_CHUNK)
          .map(section => db.prepare(insert).bind(repoId, blobSha, section.slug, searchable(section.title), searchable(section.text))));
      }
    },
    async query(repoId, match, limit) {
      await migrate();
      const rows = await db.prepare(SELECT_HITS).bind(scopedMatch(repoId, match), repoId, limit).all<SectionRow>();
      return rows.results.map((row): SearchHit => ({ blobSha: row.blob_sha, slug: row.slug, title: row.title, snippet: row.snippet }));
    },
    async deleteRepo(repoId, limit) {
      await migrate();
      // Bounded: each statement is one round trip, and the delete trigger updates the FTS index per row.
      const rows = await db.prepare("DELETE FROM sections WHERE rowid IN (SELECT rowid FROM sections WHERE repo_id = ? LIMIT ?) RETURNING rowid")
        .bind(repoId, limit).all();
      return rows.results.length;
    },
  };
}
