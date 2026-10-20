/**
 * Who may read a repository (#234). The serving Worker never calls GitHub or
 * the database on a page view: a valid capability cookie answers instead. Only
 * a cookie miss, an expired cookie or a revocation reaches these interfaces.
 *
 * P5 implements both against GitHub (docs/TECHNICAL.md, "Repository read
 * path"). Until then the Worker binds them only where configured:
 * - `RepoPermissionSource` through the `REPO_ACCESS` service binding, spoken
 *   with the small JSON protocol below. P5's control Worker mounts
 *   `repoAccessHandler(source)`.
 * - `RevocationEpochs` from the `REPO_EPOCHS` KV namespace.
 */
import { isBranchName } from "@/ingest/orchestrator/keys";
import { isOwnerLogin, isRepoName } from "@/ingest/orchestrator/messages";

export interface RepoRecord {
  /** GitHub repository ID: the storage key prefix, stable across renames. */
  id: number;
  owner: string;
  name: string;
  private: boolean;
  defaultBranch: string;
}

/** The answer is unknown (GitHub, the mirror or the binding failed): the reader gets a retryable 503, never a 404. */
export class RepoAccessUnavailable extends Error {
  constructor() {
    super("Repository access temporarily unavailable");
    this.name = "RepoAccessUnavailable";
  }
}

export interface RepoPermissionSource {
  /**
   * The repository `owner/name` (case-insensitive) when `viewer` may read it
   * now, else null. `viewer` is a Rendro user ID, or null for an anonymous
   * reader, who may read public repositories only. Null never distinguishes a
   * missing repository from a forbidden one. Throws `RepoAccessUnavailable`
   * when the answer is unknown.
   */
  authorize(viewer: string | null, owner: string, name: string): Promise<RepoRecord | null>;
}

export interface RevocationEpochs {
  /**
   * The user's revocation epoch. A capability minted at an older epoch is no
   * longer trusted. Unknown users are at 0. Throws `RepoAccessUnavailable`
   * when the store cannot answer.
   */
  currentEpoch(userId: string): Promise<number>;
}

/** KV keys `epoch:repo:<id>`: when a repository last became invisible (private, removed, uninstalled). */
export const VISIBILITY_EPOCH_KEY_PREFIX = "epoch:repo:";
/** KV keys `epoch:user:<userId>`: when a user's capabilities were last revoked. Never shares a key with a visibility epoch. */
export const USER_EPOCH_KEY_PREFIX = "epoch:user:";

export interface RepoVisibilityEpochs {
  /**
   * The repository's visibility epoch: 0 while it has always been public,
   * higher after the control plane marked it invisible. A URL minted at an
   * older epoch no longer serves. Throws `RepoAccessUnavailable` when the
   * store cannot answer.
   */
  visibilityEpoch(repoId: number): Promise<number>;
}

/** Same repository as `owner/name`, compared the way GitHub does (case-insensitively). */
export function repoKey(owner: string, name: string): string {
  return `${owner}/${name}`.toLowerCase();
}

export function parseRepoRecord(value: unknown): RepoRecord | null {
  const record = value as Partial<Record<keyof RepoRecord, unknown>> | null;
  if (!record || typeof record !== "object" || !Number.isSafeInteger(record.id) || (record.id as number) <= 0
    || !isOwnerLogin(record.owner) || !isRepoName(record.name) || typeof record.private !== "boolean"
    || !isBranchName(record.defaultBranch)) return null;
  return { id: record.id as number, owner: record.owner, name: record.name, private: record.private, defaultBranch: record.defaultBranch };
}

/** The `fetch` half of a Workers service binding. */
export interface Fetcher {
  fetch(request: Request): Promise<Response>;
}

const AUTHORIZE_URL = "https://repo-access.internal/v1/authorize";
const ACCESS_TIMEOUT_MS = 5_000;

/**
 * Client for the control Worker. POST `/v1/authorize` with
 * `{ viewer, owner, name }`; 200 `{ repo }` grants, 404 denies, anything else
 * (including a malformed or mismatched answer, or no answer within five
 * seconds) is unavailable.
 */
export function serviceRepoPermissions(binding: Fetcher, timeoutMs = ACCESS_TIMEOUT_MS): RepoPermissionSource {
  return {
    async authorize(viewer, owner, name) {
      let response: Response;
      let body: unknown;
      try {
        response = await binding.fetch(new Request(AUTHORIZE_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({ viewer, owner, name }),
          signal: AbortSignal.timeout(timeoutMs),
        }));
        if (response.status === 404) {
          await response.body?.cancel();
          return null;
        }
        body = response.ok ? await response.json() : null;
      } catch {
        throw new RepoAccessUnavailable();
      }
      const repo = parseRepoRecord((body as { repo?: unknown } | null)?.repo);
      // A source must answer for the repository asked about, never another one.
      if (!repo || repoKey(repo.owner, repo.name) !== repoKey(owner, name)) throw new RepoAccessUnavailable();
      return repo;
    },
  };
}

function json(status: number, value: unknown): Response {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}

/** The control Worker's side of the protocol: P5 passes its GitHub-backed source. */
export function repoAccessHandler(source: RepoPermissionSource): (request: Request) => Promise<Response> {
  return async (request) => {
    if (request.method !== "POST" || new URL(request.url).pathname !== "/v1/authorize") return json(404, {});
    let input: { viewer?: unknown; owner?: unknown; name?: unknown };
    try {
      input = await request.json() as typeof input;
    } catch {
      return json(400, { error: "Malformed request" });
    }
    const viewer = input?.viewer;
    if (!(viewer === null || (typeof viewer === "string" && viewer.length > 0 && viewer.length <= 256))
      || !isOwnerLogin(input.owner) || !isRepoName(input.name)) return json(400, { error: "Malformed request" });
    try {
      const repo = await source.authorize(viewer, input.owner, input.name);
      return repo ? json(200, { repo }) : json(404, {});
    } catch {
      return json(503, { error: "Unavailable" });
    }
  };
}

/** The read half of a Workers KV binding. */
export interface KvReader {
  get(key: string, options: { cacheTtl: number }): Promise<string | null>;
}

/** One epoch from KV: absent is 0; a failure or anything but a decimal safe integer is unavailable. */
async function readEpoch(kv: KvReader, key: string): Promise<number> {
  let value: string | null;
  try {
    value = await kv.get(key, { cacheTtl: 60 });
  } catch {
    throw new RepoAccessUnavailable();
  }
  if (value === null) return 0;
  // Fifteen digits stay a safe integer; anything else is a broken writer, not a revocation.
  if (!/^\d{1,15}$/.test(value)) throw new RepoAccessUnavailable();
  return Number(value);
}

/**
 * Epochs in KV under `epoch:user:<userId>`, as decimal milliseconds. P5 writes
 * the time of the revocation (never a read-modify-write increment, which loses
 * concurrent bumps), after its access mirror already denies the grant.
 * `cacheTtl` keeps hot keys in the colo for 60 s, the floor KV Classic allows.
 */
export function kvRevocationEpochs(kv: KvReader): RevocationEpochs {
  return {
    currentEpoch: userId => readEpoch(kv, `${USER_EPOCH_KEY_PREFIX}${userId}`),
  };
}

/**
 * Visibility epochs in KV under `epoch:repo:<id>`, written by the control
 * plane's directory when a repository stops being public. `cacheTtl` keeps hot
 * keys in the colo for 60 s, the floor KV Classic allows: that is the
 * revocation bound of an outstanding shared-cache URL (#242).
 */
export function kvVisibilityEpochs(kv: KvReader): RepoVisibilityEpochs {
  return {
    visibilityEpoch: (repoId) => readEpoch(kv, `${VISIBILITY_EPOCH_KEY_PREFIX}${repoId}`),
  };
}
