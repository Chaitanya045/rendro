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
 * External-content FTS5 over a plain `sections` table, so a section's text is
 * stored once. The triggers keep the FTS index in step; `DELETE` then `INSERT`
 * per blob makes re-indexing a changed page idempotent. `rowid` is the join
 * key: the primary key is composite, so the table is still a rowid table.
 * `trigram` is the tokenizer: code identifiers and partial words match, and a
 * query term must be at least three characters.
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
  `CREATE VIRTUAL TABLE IF NOT EXISTS sections_fts USING fts5(
    title, body, content='sections', content_rowid='rowid', tokenize='trigram'
  )`,
  `CREATE TRIGGER IF NOT EXISTS sections_ai AFTER INSERT ON sections BEGIN
    INSERT INTO sections_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body);
  END`,
  `CREATE TRIGGER IF NOT EXISTS sections_ad AFTER DELETE ON sections BEGIN
    INSERT INTO sections_fts(sections_fts, rowid, title, body) VALUES ('delete', old.rowid, old.title, old.body);
  END`,
  `CREATE TRIGGER IF NOT EXISTS sections_au AFTER UPDATE ON sections BEGIN
    INSERT INTO sections_fts(sections_fts, rowid, title, body) VALUES ('delete', old.rowid, old.title, old.body);
    INSERT INTO sections_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body);
  END`,
];

// D1 batches are single round trips; keep them small enough to stay well under
// the request size limit on a pathologically sectioned page.
const INSERT_CHUNK = 40;

// snippet(): column 1 is `body`; \u0002/\u0003 wrap each matched run so the
// client can build <mark> nodes from text, never HTML. With the trigram
// tokenizer the window counts 3-character tokens, so 64 is about 64 characters
// of context. bm25 weights the title five times the body; lower is better.
const SELECT_HITS = `SELECT s.blob_sha AS blob_sha, s.slug AS slug, s.title AS title,
  snippet(sections_fts, 1, char(2), char(3), '...', 64) AS snippet
  FROM sections_fts JOIN sections s ON s.rowid = sections_fts.rowid
  WHERE sections_fts MATCH ? AND s.repo_id = ?
  ORDER BY bm25(sections_fts, 5.0, 1.0) LIMIT ?`;

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
          .map(section => db.prepare(insert).bind(repoId, blobSha, section.slug, section.title, section.text)));
      }
    },
    async query(repoId, match, limit) {
      await migrate();
      const rows = await db.prepare(SELECT_HITS).bind(match, repoId, limit).all<SectionRow>();
      return rows.results.map((row): SearchHit => ({ blobSha: row.blob_sha, slug: row.slug, title: row.title, snippet: row.snippet }));
    },
  };
}
