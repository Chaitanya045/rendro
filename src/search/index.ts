import type { PageSection } from "@/ingest/sections";

/**
 * The repository search index (#251). Implementations must be safe to call
 * concurrently and idempotently: ingest retries a commit and may index the
 * same blob more than once, and only the query side reads on the hot path.
 */
export interface SearchIndex {
  /**
   * Create the tables, triggers and FTS index if they do not exist. Idempotent. Writes call it first; `query`
   * does not (#358): it migrates and retries once only when the schema turns out to be missing.
   */
  migrate(): Promise<void>;
  /** Whether any section of this blob is already indexed. */
  hasBlob(repoId: number, blobSha: string): Promise<boolean>;
  /**
   * Replace every indexed section of `blobSha` with `sections`. Idempotent.
   * `replace: false` says the blob has no rows (a `hasBlob` miss), so nothing is deleted first.
   */
  putBlob(repoId: number, blobSha: string, sections: readonly PageSection[], options?: { replace?: boolean }): Promise<void>;
  /** Run a pre-neutralized FTS5 MATCH expression, at most `limit` rows. */
  query(repoId: number, match: string, limit: number): Promise<SearchHit[]>;
  /** Delete at most `limit` of the repository's sections (a purge or an expiry, #263). Returns how many went; 0 means none are left. */
  deleteRepo(repoId: number, limit: number): Promise<number>;
}

export interface SearchHit {
  /** Git blob SHA of the document the section came from. */
  blobSha: string;
  /** The `#fragment` anchor id, or "" for a preamble/slugless section. */
  slug: string;
  title: string;
  /** Section text with `\u0002`/`\u0003` around each matched run. */
  snippet: string;
}
