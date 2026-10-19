/**
 * First view of a repository or branch with no snapshot yet (#242): after
 * authorization succeeds, the read path enqueues a P3b ingest through the
 * per-repository coordinator Durable Object and renders the preparing page.
 * A plain 404 elsewhere: unauthorized readers, commit URLs and every
 * non-shell target enqueue nothing and leak nothing.
 */
import type { RepoRef } from "@/ingest/github/source";
import { coordinatorClient, firstViewEnsurer, type DurableObjectNamespaceLike } from "@/ingest/orchestrator/coordinator-client";
import type { IngestOutcome, RepoTouch } from "@/ingest/orchestrator/coordinator";
import type { RepoGrant } from "./grant";

/** The same shape check the read path uses for its bindings. */
function hasMethods(value: unknown, names: string[]): boolean {
  return typeof value === "object" && value !== null && names.every(name => typeof (value as Record<string, unknown>)[name] === "function");
}

/** What the read path needs: enqueue one ingest for this repository's branch, and report views (#263). */
export interface RepoFirstView {
  ensure(repo: RepoRef, branch: string): Promise<IngestOutcome>;
  touch(touch: RepoTouch): Promise<unknown>;
}

const firstViews = new WeakMap<object, RepoFirstView>();

/** The ingest coordinator binding, shaped once per isolate so concurrent
 * readers of the same branch share a single Durable Object call. */
export function durableFirstView(binding: unknown): RepoFirstView | null {
  if (!hasMethods(binding, ["idFromName", "get"])) return null;
  const namespace = binding as DurableObjectNamespaceLike;
  const existing = firstViews.get(namespace);
  if (existing) return existing;
  const view = {
    ensure: firstViewEnsurer(repoId => coordinatorClient(namespace, repoId)),
    touch: (touch: RepoTouch) => coordinatorClient(namespace, touch.id).touch(touch),
  };
  firstViews.set(namespace, view);
  return view;
}

/** One touch per repository and visibility per isolate this often: views never cost a write each (#263). */
export const TOUCH_INTERVAL_MS = 60 * 60_000;
const MAX_TOUCHED = 4_096;
const touched = new Map<string, number>();

/**
 * Tell the repository's coordinator it was viewed, at most once an hour per
 * isolate (idle expiry needs only a coarse time; the coordinator keeps it to
 * the day). A change of visibility is reported at once: content stored before
 * a repository was made private is replaced with sealed content. Unattended,
 * and a failure only costs precision.
 */
export function touchRepo(firstView: RepoFirstView | null, grant: RepoGrant, now: number, waitUntil: (promise: Promise<unknown>) => void): void {
  if (!firstView) return;
  const key = `${grant.repo.id}:${grant.repo.private}`;
  const last = touched.get(key);
  if (last !== undefined && now - last < TOUCH_INTERVAL_MS) return;
  touched.delete(key);
  touched.set(key, now);
  if (touched.size > MAX_TOUCHED) touched.delete(touched.keys().next().value as string);
  waitUntil(firstView.touch({ id: grant.repo.id, private: grant.repo.private }).catch(() => {}));
}

export function clearTouches(): void {
  touched.clear();
}

/** The ingest the pointer refers to: the repository's id and admission state, the branch the URL asks for. */
export function repoIngestTarget(grant: RepoGrant, branch: string): { repo: RepoRef; branch: string } {
  return {
    repo: { id: grant.repo.id, owner: grant.repo.owner, name: grant.repo.name, private: grant.repo.private, installationId: null },
    branch,
  };
}

/** How the serving path stops waiting for the build: after this window it
 * renders the preparing page while the ingest continues unattended (#242),
 * and every later poll asks the coordinator again. */
export const PREPARE_WINDOW_MS = 5_000;

export interface PrepareAttempt {
  /** null when the window expired before the outcome arrived. */
  outcome: IngestOutcome | null;
}

/** Ask the coordinator for one ingest at most this window; hand the build to
 * `waitUntil` so it proceeds even when the reader stops waiting. A transport
 * failure still throws: could-not-check is retryable 503 (#225), never 404. */
export async function prepareRepo(
  firstView: Pick<RepoFirstView, "ensure">, repo: RepoRef, branch: string, windowMs: number,
  waitUntil: (promise: Promise<unknown>) => void,
): Promise<PrepareAttempt> {
  const flight = firstView.ensure(repo, branch);
  let fulfilled = false;
  let outcome: IngestOutcome | null = null;
  flight.then(value => { outcome = value; fulfilled = true; }, () => {});
  const inWindow = await Promise.race([
    flight.then(() => true, () => false),
    new Promise<null>(resolve => setTimeout(() => resolve(null), windowMs)),
  ]);
  // Unattended either way: the build proceeds when the reader stops waiting.
  // (Rejections surface through the direct paths, not through waitUntil.)
  waitUntil(flight.catch(() => {}));
  if (inWindow !== null && !fulfilled) await flight;
  return { outcome: fulfilled ? outcome : null };
}

/** What the sole ingest answer means for the reader. */
export function interpretOutcome(outcome: IngestOutcome): "ready" | "preparing" | "failed" | "absent" {
  switch (outcome.status) {
    case "flipped":
    case "current":
      return "ready";
    case "duplicate":
      return "preparing";
    case "no-ref":
      return "absent";
    case "idle":
      // Never an answer to `ensure`, which clears expiry; as a precaution the reader polls again.
      return "preparing";
    case "failed":
      return "failed";
  }
}
