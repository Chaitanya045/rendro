import type { SnapshotManifest } from "@/ingest/orchestrator/snapshot";
import { MAX_QUERY_LENGTH, neutralizeQuery } from "@/search/query";
import type { SearchIndex } from "@/search/index";

/**
 * The repository search query boundary (#251): bounds the query and page size,
 * neutralizes the FTS expression and maps candidate hits back onto the served
 * commit's manifest. Hits are keyed by blob SHA, so a match is only returned
 * when some renderable page of this exact snapshot carries that blob — the
 * same content at a different path in a newer commit can never leak results
 * from another commit or repository.
 */

export const DEFAULT_SEARCH_LIMIT = 20;
export const MAX_SEARCH_LIMIT = 50;
/** Shared with the neutralizer and the shell input's `maxlength`. */
export const MAX_SEARCH_QUERY_LENGTH = MAX_QUERY_LENGTH;
// Fetch more candidates than requested because some are filtered out by the
// commit scoping above; `more` is approximate past this factor.
const CANDIDATE_FACTOR = 4;

export interface SearchResult {
  /** Repository-relative path of the document, as the shell and frames use it. */
  path: string;
  /** `#fragment` anchor id of the section, "" when it has no anchor. */
  slug: string;
  title: string;
  /** Section text with \u0002/\u0003 around each matched run. */
  snippet: string;
}

export type SearchOutcome =
  | { status: "ok"; results: SearchResult[]; more: boolean }
  | { status: "invalid" };

/** Every page of this snapshot by blob SHA, so a moved blob still resolves to its current path. */
function pagesBySha(manifest: SnapshotManifest): Map<string, string> {
  const pages = new Map<string, string>();
  for (const [path, file] of Object.entries(manifest.files)) {
    if (file.render !== undefined && file.error === undefined) pages.set(file.sha, path);
  }
  return pages;
}

function parseLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_SEARCH_LIMIT;
  return Math.min(Math.max(Math.trunc(value), 1), MAX_SEARCH_LIMIT);
}

export async function searchManifest(index: SearchIndex, manifest: SnapshotManifest, query: string, limit?: number): Promise<SearchOutcome> {
  if (query.length > MAX_SEARCH_QUERY_LENGTH) return { status: "invalid" };
  const size = parseLimit(limit);
  const match = neutralizeQuery(query);
  if (match === null) return { status: "ok", results: [], more: false };

  const candidates = await index.query(manifest.repoId, match, size * CANDIDATE_FACTOR);
  const pages = pagesBySha(manifest);
  const results: SearchResult[] = [];
  const seen = new Set<string>();
  for (const hit of candidates) {
    const path = pages.get(hit.blobSha);
    if (path === undefined || seen.has(`${path}#${hit.slug}`)) continue;
    seen.add(`${path}#${hit.slug}`);
    results.push({ path, slug: hit.slug, title: hit.title, snippet: hit.snippet });
    if (results.length === size) break;
  }
  const more = candidates.length >= size * CANDIDATE_FACTOR;
  return { status: "ok", results, more };
}
