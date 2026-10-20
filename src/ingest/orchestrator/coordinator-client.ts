import type { RepoRef } from "../github/source";
import { SingleFlight } from "./concurrency";
import type { EnsureOutcome, IngestOutcome, PurgeOutcome, ReconcileOutcome, RepoTouch } from "./coordinator";
import type { IngestMessage } from "./messages";

/** The subset of a DurableObjectNamespace binding used here. */
export interface DurableObjectNamespaceLike {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(input: string, init?: RequestInit): Promise<Response> };
}

export interface CoordinatorClient {
  ingest(message: IngestMessage): Promise<IngestOutcome>;
  /** `defaultBranch`: the branch is the repository's default, which first-view budgets exempt (#294). */
  ensure(repo: RepoRef, branch: string, defaultBranch?: boolean): Promise<EnsureOutcome>;
  reconcile(repo: RepoRef): Promise<ReconcileOutcome>;
  /** A view (#263): last access for idle expiry, and the visibility the reader was granted. */
  touch(touch: RepoTouch): Promise<{ status: "ok" | "misrouted" }>;
  /** GitHub confirmed the removal (#258): delete the repository's content. */
  purge(repoId: number): Promise<PurgeOutcome>;
}

/** The Durable Object name for a repository: its GitHub ID, which survives renames and transfers. */
export function coordinatorName(repoId: number): string {
  return `repo:${repoId}`;
}

export function coordinatorClient(namespace: DurableObjectNamespaceLike, repoId: number): CoordinatorClient {
  const stub = namespace.get(namespace.idFromName(coordinatorName(repoId)));
  const call = async <T>(path: string, body: unknown): Promise<T> => {
    const response = await stub.fetch(`https://coordinator${path}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`Coordinator answered ${response.status}`);
    return await response.json() as T;
  };
  return {
    ingest: (message) => call("/ingest", message),
    ensure: (repo, branch, defaultBranch = false) => call("/ensure", { repo, branch, defaultBranch }),
    reconcile: (repo) => call("/reconcile", { repo }),
    touch: (touch) => call("/touch", { id: touch.id, private: touch.private }),
    purge: (repoId) => call("/purge", { repoId }),
  };
}

/**
 * First view of a branch nobody has ingested: concurrent readers in one
 * isolate share one Durable Object call, and the Durable Object shares one
 * ingest across isolates. (Wired into the serving path in P4.)
 */
export function firstViewEnsurer(
  clientFor: (repoId: number) => CoordinatorClient,
): (repo: RepoRef, branch: string, defaultBranch?: boolean) => Promise<EnsureOutcome> {
  const flights = new SingleFlight<EnsureOutcome>();
  return (repo, branch, defaultBranch = false) => flights.run(`${repo.id}:${branch}`, () => clientFor(repo.id).ensure(repo, branch, defaultBranch));
}
