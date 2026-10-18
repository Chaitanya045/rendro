import type { CachedRef, GitHubSource, RepoRef } from "../github/source";
import { IngestError, toIngestError } from "./errors";
import { manifestKey, refKey } from "./keys";
import type { ContentPipeline } from "./pipeline";
import { buildSnapshot, type SnapshotManifest, type SnapshotOptions, type SnapshotStats } from "./snapshot";
import { readJson, RepoContent, writeJson, type ContentSealer, type ObjectStore } from "./store";

/** Which complete snapshot a branch serves. Written only after that snapshot's manifest exists. */
export interface RefPointer {
  schema: 1;
  repoId: number;
  branch: string;
  commit: string;
  rendererVersion: number;
  /** Increments on every flip; flips are serialized per repository. */
  sequence: number;
  flippedAt: string;
}

/** Remembers the last ETag per branch, so unchanged heads cost a free 304. */
export interface RefEtagCache {
  get(branch: string): Promise<CachedRef | null>;
  set(branch: string, value: CachedRef): Promise<void>;
}

export interface IngestDependencies {
  source: GitHubSource;
  store: ObjectStore;
  sealer: ContentSealer;
  pipeline: ContentPipeline;
  now: () => number;
  snapshot?: SnapshotOptions;
}

export type IngestResult =
  | { status: "flipped"; commit: string; previous: string | null; snapshot: "built" | "existing"; stats: SnapshotStats | null; headMoved: boolean }
  | { status: "current"; commit: string }
  | { status: "no-ref" };

export async function readPointer(store: ObjectStore, repoId: number, branch: string): Promise<{ value: RefPointer; etag: string } | null> {
  return readJson<RefPointer>(store, refKey(repoId, branch));
}

/**
 * Bring one branch up to date with what GitHub reports as its head now.
 *
 * Render-then-flip: the pointer moves only after the commit's complete
 * snapshot exists, and only through a compare-and-swap on the pointer object.
 * The caller serializes calls per repository, so the head observed here is
 * never older than the one behind the current pointer: out-of-order and
 * duplicate deliveries cannot move a branch backwards.
 */
export async function ingestBranch(
  deps: IngestDependencies, etags: RefEtagCache, repo: RepoRef, branch: string, onHead: (sha: string) => void = () => {},
): Promise<IngestResult> {
  const { source, store, pipeline } = deps;
  const current = await readPointer(store, repo.id, branch);
  const cached = await etags.get(branch);
  const head = await source.getRef(repo, branch, cached);
  if (!head) return { status: "no-ref" };
  onHead(head.sha);
  if (head.etag && !head.notModified) await etags.set(branch, { etag: head.etag, sha: head.sha });
  const pointer = current?.value ?? null;
  if (pointer?.commit === head.sha && pointer.rendererVersion === pipeline.rendererVersion) {
    return { status: "current", commit: head.sha };
  }

  const content = new RepoContent(store, repo, deps.sealer);
  let snapshot: "built" | "existing" = "existing";
  let stats: SnapshotStats | null = null;
  try {
    if (!await store.has(manifestKey(repo.id, head.sha, pipeline.rendererVersion))) {
      const previous = pointer ? await content.getJson<SnapshotManifest>(manifestKey(repo.id, pointer.commit, pointer.rendererVersion)) : null;
      stats = (await buildSnapshot({ source, content, repo, pipeline, now: deps.now, options: deps.snapshot }, head.sha, previous)).stats;
      snapshot = "built";
    }
  } catch (error) {
    throw withCommit(toIngestError(error), head.sha);
  }

  const next: RefPointer = {
    schema: 1, repoId: repo.id, branch, commit: head.sha, rendererVersion: pipeline.rendererVersion,
    sequence: (pointer?.sequence ?? 0) + 1, flippedAt: new Date(deps.now()).toISOString(),
  };
  if (!await writeJson(store, refKey(repo.id, branch), next, current?.etag)) {
    throw withCommit(new IngestError("pointer-conflict", "The ref pointer changed during ingest", false), head.sha);
  }
  return { status: "flipped", commit: head.sha, previous: pointer?.commit ?? null, snapshot, stats, headMoved: await headMoved(source, etags, repo, branch, head.sha) };
}

/** After a flip: did the branch move while the snapshot was built? Usually a free 304. Never fails the flipped job. */
async function headMoved(source: GitHubSource, etags: RefEtagCache, repo: RepoRef, branch: string, built: string): Promise<boolean> {
  try {
    const cached = await etags.get(branch);
    const head = await source.getRef(repo, branch, cached);
    if (head?.etag && !head.notModified) await etags.set(branch, { etag: head.etag, sha: head.sha });
    return head !== null && head.sha !== built;
  } catch {
    return false;
  }
}

export class CommitIngestError extends IngestError {
  constructor(cause: IngestError, readonly commit: string) {
    super(cause.reason, cause.message, cause.permanent, cause.retryAt);
    this.name = "CommitIngestError";
  }
}

function withCommit(error: IngestError, commit: string): CommitIngestError {
  return new CommitIngestError(error, commit);
}
