import { isGitObjectId, matchesBlobId } from "./git-objects";
import { RateGovernor, systemClock, type Clock } from "./rate-governor";
import { GitHubError, type CachedRef, type GitHubSource, type GitTree, type GitTreeEntry, type RefHead, type RepoRef } from "./source";
import type { InstallationTokenProvider } from "./token";

export interface HttpGitHubSourceOptions {
  tokens: InstallationTokenProvider;
  fetch?: typeof fetch;
  /** REST API origin. Tests and local development point this at a fake GitHub. */
  apiOrigin?: string;
  /** Origins an archive redirect may lead to. The installation token is never sent to them. */
  archiveOrigins?: readonly string[];
  governor?: RateGovernor;
  clock?: Clock;
  /** Attempts for 5xx, network errors and short rate-limit waits. */
  maxAttempts?: number;
  retryBaseMs?: number;
  timeoutMs?: number;
}

export type GitHubEndpoint = "ref" | "tree" | "blob" | "tarball" | "archive";

const API_VERSION = "2022-11-28";
const MAX_JSON_BYTES = 64 * 1024;
/** A full recursive listing is at most 7 MB; leave headroom for JSON formatting. */
const MAX_TREE_BYTES = 16 * 1024 * 1024;
const MAX_ERROR_BYTES = 8 * 1024;
const REDIRECTS = new Set([301, 302, 307, 308]);
const MAX_REDIRECTS = 3;

interface RequestSpec {
  endpoint: GitHubEndpoint;
  url: string;
  accept: string;
  etag?: string | null;
  authenticated: boolean;
  installationId: number | null;
}

/** GitHubSource over the REST API: conditional requests, rate-limit pacing and bounded retries. */
export class HttpGitHubSource implements GitHubSource {
  private readonly tokens: InstallationTokenProvider;
  private readonly fetcher: typeof fetch;
  private readonly apiOrigin: string;
  private readonly archiveOrigins: ReadonlySet<string>;
  readonly governor: RateGovernor;
  private readonly clock: Clock;
  private readonly maxAttempts: number;
  private readonly retryBaseMs: number;
  private readonly timeoutMs: number;
  /** Requests sent, by endpoint, including 304s and failed attempts. */
  readonly requests: Record<GitHubEndpoint, number> = { ref: 0, tree: 0, blob: 0, tarball: 0, archive: 0 };
  notModified = 0;

  constructor(options: HttpGitHubSourceOptions) {
    this.tokens = options.tokens;
    this.fetcher = options.fetch ?? ((input, init) => fetch(input, init));
    this.apiOrigin = new URL(options.apiOrigin ?? "https://api.github.com").origin;
    this.archiveOrigins = new Set((options.archiveOrigins ?? ["https://codeload.github.com"]).map((origin) => new URL(origin).origin));
    this.clock = options.clock ?? systemClock;
    this.governor = options.governor ?? new RateGovernor({ clock: this.clock });
    this.maxAttempts = options.maxAttempts ?? 3;
    this.retryBaseMs = options.retryBaseMs ?? 250;
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  async getRef(repo: RepoRef, branch: string, cached?: CachedRef | null): Promise<RefHead | null> {
    const path = branch.split("/").map(encodeURIComponent).join("/");
    let response: Response;
    try {
      response = await this.send({
        endpoint: "ref", url: this.repoUrl(repo, `git/ref/heads/${path}`), accept: "application/vnd.github+json",
        etag: cached?.etag, authenticated: true, installationId: repo.installationId,
      });
    } catch (error) {
      // 409 is an empty repository; both mean "no commit to ingest".
      if (error instanceof GitHubError && error.kind === "not-found") return null;
      throw error;
    }
    if (response.status === 304) {
      if (!cached) throw new GitHubError("invalid-response", "304 without a conditional request", 304);
      this.notModified += 1;
      return { sha: cached.sha, etag: cached.etag, notModified: true };
    }
    const body = await readJson(response, MAX_JSON_BYTES) as { ref?: unknown; object?: { sha?: unknown; type?: unknown } } | null;
    const sha = body?.object?.sha;
    if (body?.ref !== `refs/heads/${branch}` || body.object?.type !== "commit" || !isGitObjectId(sha)) {
      throw new GitHubError("invalid-response", "Unexpected ref response", response.status);
    }
    return { sha, etag: response.headers.get("etag"), notModified: false };
  }

  async getTree(repo: RepoRef, sha: string, recursive: boolean): Promise<GitTree> {
    requireObjectId(sha);
    const response = await this.send({
      endpoint: "tree", url: this.repoUrl(repo, `git/trees/${sha}${recursive ? "?recursive=1" : ""}`),
      accept: "application/vnd.github+json", authenticated: true, installationId: repo.installationId,
    });
    return parseTree(await readJson(response, MAX_TREE_BYTES), recursive);
  }

  async getBlob(repo: RepoRef, sha: string, maxBytes: number): Promise<Uint8Array> {
    requireObjectId(sha);
    const response = await this.send({
      endpoint: "blob", url: this.repoUrl(repo, `git/blobs/${sha}`), accept: "application/vnd.github.raw+json",
      authenticated: true, installationId: repo.installationId,
    });
    const bytes = await readBytes(response, maxBytes);
    if (!await matchesBlobId(bytes, sha)) throw new GitHubError("invalid-response", "Blob content does not match its ID", response.status);
    return bytes;
  }

  async getTarball(repo: RepoRef, sha: string): Promise<ReadableStream<Uint8Array>> {
    requireObjectId(sha);
    let response = await this.send({
      endpoint: "tarball", url: this.repoUrl(repo, `tarball/${sha}`), accept: "application/vnd.github+json",
      authenticated: true, installationId: repo.installationId,
    });
    if (response.status >= 300) {
      // The archive link is temporary (five minutes for private repos): follow it now, never store it.
      const location = response.headers.get("location");
      await response.body?.cancel();
      const target = location ? safeUrl(location) : null;
      if (!target || !this.archiveOrigins.has(target.origin)) {
        throw new GitHubError("invalid-response", "Archive redirect to an unexpected origin", response.status);
      }
      response = await this.send({
        endpoint: "archive", url: target.href, accept: "application/octet-stream", authenticated: false, installationId: repo.installationId,
      });
      if (response.status >= 300) {
        await response.body?.cancel();
        throw new GitHubError("invalid-response", "Archive download redirected again", response.status);
      }
    }
    if (!response.body) throw new GitHubError("invalid-response", "Archive response has no body", response.status);
    return response.body.pipeThrough(new DecompressionStream("gzip"));
  }

  private repoUrl(repo: RepoRef, path: string): string {
    return `${this.apiOrigin}/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/${path}`;
  }

  /** One logical request with bounded retries. Returns 2xx, 3xx and 304 responses; throws GitHubError otherwise. */
  private async send(request: RequestSpec): Promise<Response> {
    let spec = request;
    let refreshedToken = false;
    let redirects = 0;
    for (let attempt = 1; ; attempt += 1) {
      const release = await this.governor.acquire(spec.endpoint);
      let response: Response;
      try {
        response = await this.fetcher(spec.url, {
          headers: await this.headers(spec),
          redirect: "manual",
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (error) {
        this.requests[spec.endpoint] += 1;
        if (attempt < this.maxAttempts) {
          await this.backoff(attempt);
          continue;
        }
        throw new GitHubError("network", `GitHub request failed: ${errorName(error)}`);
      } finally {
        release();
      }
      this.requests[spec.endpoint] += 1;
      this.governor.observe(response.headers);
      const { status } = response;
      if (REDIRECTS.has(status) && spec.endpoint !== "tarball" && spec.endpoint !== "archive") {
        // A renamed or transferred repository answers 301 to its old path. Follow within the API origin only.
        const location = response.headers.get("location");
        await response.body?.cancel();
        const target = location ? safeUrl(location, spec.url) : null;
        if (!target || target.origin !== this.apiOrigin || redirects >= MAX_REDIRECTS) {
          throw new GitHubError("invalid-response", "Unexpected GitHub redirect", status);
        }
        redirects += 1;
        attempt -= 1;
        spec = { ...spec, url: target.href };
        continue;
      }
      if (status < 400) {
        this.governor.succeeded();
        return response;
      }
      const message = await readErrorMessage(response);
      if (status === 401 && spec.authenticated && !refreshedToken) {
        refreshedToken = true;
        this.tokens.invalidate(spec.installationId);
        continue;
      }
      if (status === 403 || status === 429) {
        const retryAt = this.governor.limited(status, response.headers, message);
        if (retryAt === null) throw new GitHubError("forbidden", "GitHub denied the request", status);
        if (attempt < this.maxAttempts && retryAt - this.clock.now() <= this.governor.maxInlineWaitMs) continue;
        throw new GitHubError("rate-limited", "GitHub rate limit", status, retryAt);
      }
      if (status === 404 || status === 409 || status === 410) throw new GitHubError("not-found", "Not found on GitHub", status);
      if (status === 401) throw new GitHubError("unauthorized", "GitHub rejected the token", status);
      if (status >= 500) {
        if (attempt < this.maxAttempts) {
          await this.backoff(attempt);
          continue;
        }
        throw new GitHubError("server", "GitHub server error", status);
      }
      throw new GitHubError("invalid-response", "Unexpected GitHub response", status);
    }
  }

  private async headers(spec: RequestSpec): Promise<Headers> {
    const headers = new Headers({ accept: spec.accept, "user-agent": "rendro-ingest", "x-github-api-version": API_VERSION });
    if (spec.etag) headers.set("if-none-match", spec.etag);
    if (spec.authenticated) {
      const token = await this.tokens.token(spec.installationId);
      if (token) headers.set("authorization", `Bearer ${token}`);
    }
    return headers;
  }

  private backoff(attempt: number): Promise<void> {
    const delay = this.retryBaseMs * 2 ** (attempt - 1);
    return this.clock.sleep(delay + Math.floor(Math.random() * delay));
  }
}

function requireObjectId(sha: string): void {
  if (!isGitObjectId(sha)) throw new TypeError("Expected a git object ID");
}

function safeUrl(value: string, base?: string): URL | null {
  try {
    return new URL(value, base);
  } catch {
    return null;
  }
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "unknown error";
}

const TYPES = new Set(["blob", "tree", "commit"]);

/** Validate a trees response. Paths become the repository paths ingest stores under, so reject anything unusual. */
export function parseTree(body: unknown, recursive: boolean): GitTree {
  const value = body as { sha?: unknown; tree?: unknown; truncated?: unknown } | null;
  if (!value || !isGitObjectId(value.sha) || !Array.isArray(value.tree)) {
    throw new GitHubError("invalid-response", "Unexpected tree response");
  }
  const entries: GitTreeEntry[] = [];
  for (const raw of value.tree as unknown[]) {
    const item = raw as Partial<Record<keyof GitTreeEntry, unknown>> | null;
    if (!item || typeof item.path !== "string" || typeof item.mode !== "string" || typeof item.type !== "string"
      || !TYPES.has(item.type) || !isGitObjectId(item.sha) || !isTreePath(item.path, recursive)
      || (item.size !== undefined && !Number.isSafeInteger(item.size))) {
      throw new GitHubError("invalid-response", "Unexpected tree entry");
    }
    const entry: GitTreeEntry = { path: item.path, mode: item.mode, type: item.type as GitTreeEntry["type"], sha: item.sha };
    if (typeof item.size === "number") entry.size = item.size;
    entries.push(entry);
  }
  return { sha: value.sha, entries, truncated: value.truncated === true };
}

function isTreePath(path: string, recursive: boolean): boolean {
  const segments = path.split("/");
  if (!recursive && segments.length !== 1) return false;
  // eslint-disable-next-line no-control-regex
  return segments.every((segment) => segment !== "" && segment !== "." && segment !== ".." && !/[\u0000-\u001f\u007f\\]/.test(segment));
}

async function readJson(response: Response, maxBytes: number): Promise<unknown> {
  const bytes = await readBytes(response, maxBytes);
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new GitHubError("invalid-response", "GitHub returned invalid JSON", response.status);
  }
}

/** Read a body without ever holding more than `maxBytes`. */
export async function readBytes(response: Response, maxBytes: number): Promise<Uint8Array<ArrayBuffer>> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel();
    throw new GitHubError("too-large", "GitHub response exceeds the size limit", response.status);
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    let result: ReadableStreamReadResult<Uint8Array>;
    try {
      result = await reader.read();
    } catch (error) {
      throw new GitHubError("network", `GitHub response interrupted: ${errorName(error)}`, response.status);
    }
    if (result.done) break;
    total += result.value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new GitHubError("too-large", "GitHub response exceeds the size limit", response.status);
    }
    chunks.push(result.value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function readErrorMessage(response: Response): Promise<string> {
  try {
    return new TextDecoder().decode(await readBytes(response, MAX_ERROR_BYTES));
  } catch {
    return "";
  }
}
