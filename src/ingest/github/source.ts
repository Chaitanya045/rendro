/**
 * The narrow GitHub surface ingest needs. The HTTP implementation talks to the
 * REST API with an installation token; tests drive the same implementation
 * against a fake GitHub (tests/helpers/fake-github.ts).
 */

/** A repository as ingest addresses it. `id` is GitHub's numeric ID, stable across renames and transfers. */
export interface RepoRef {
  id: number;
  owner: string;
  name: string;
  private: boolean;
  /** GitHub App installation whose token reads this repo; null until P1 provides installations. */
  installationId: number | null;
}

/** A previously seen response, replayed when GitHub answers 304. */
export interface CachedRef {
  etag: string;
  sha: string;
}

export interface RefHead {
  sha: string;
  etag: string | null;
  /** True when GitHub answered 304 to the cached ETag; such a request costs no primary quota. */
  notModified: boolean;
}

/** One entry of a git tree listing. `path` is repository-relative. */
export interface GitTreeEntry {
  path: string;
  mode: string;
  type: "blob" | "tree" | "commit";
  sha: string;
  size?: number;
}

export interface GitTree {
  /** The tree's own object ID (the root tree when a commit was requested). */
  sha: string;
  entries: GitTreeEntry[];
  /** GitHub stops recursive listings at 100,000 entries or 7 MB and sets this flag. */
  truncated: boolean;
}

export interface GitHubSource {
  /** The commit a branch points at, or null when the branch (or the whole repository) has no commits. */
  getRef(repo: RepoRef, branch: string, cached?: CachedRef | null): Promise<RefHead | null>;
  /** A tree by tree or commit ID. Paths of a non-recursive listing are entry names. */
  getTree(repo: RepoRef, sha: string, recursive: boolean): Promise<GitTree>;
  /** Raw blob bytes, checked against `sha`. */
  getBlob(repo: RepoRef, sha: string, maxBytes: number): Promise<Uint8Array>;
  /** The commit's archive as an uncompressed tar stream (the archive link is followed immediately; it expires). */
  getTarball(repo: RepoRef, sha: string): Promise<ReadableStream<Uint8Array>>;
}

export type GitHubErrorKind =
  /** Repository, ref or object missing, or no longer visible to the token. */
  | "not-found"
  | "unauthorized"
  | "forbidden"
  /** Primary or secondary rate limit; `retryAt` says when to come back. */
  | "rate-limited"
  | "server"
  | "network"
  /** A response that does not match the documented shape or the requested object. */
  | "invalid-response"
  | "too-large";

const TRANSIENT: ReadonlySet<GitHubErrorKind> = new Set(["rate-limited", "server", "network", "unauthorized"]);

export class GitHubError extends Error {
  constructor(
    readonly kind: GitHubErrorKind,
    message: string,
    readonly status: number | null = null,
    /** Epoch milliseconds before which no request should be sent. */
    readonly retryAt: number | null = null,
  ) {
    super(message);
    this.name = "GitHubError";
  }

  /** Worth retrying later. Unauthorized is transient because installation tokens rotate hourly. */
  get transient(): boolean {
    return TRANSIENT.has(this.kind);
  }
}
