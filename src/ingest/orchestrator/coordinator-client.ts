import type { RepoRef } from "../github/source";
import { SingleFlight } from "./concurrency";
import type { IngestOutcome, ReconcileOutcome } from "./coordinator";
import type { IngestMessage } from "./messages";

/** The subset of a DurableObjectNamespace binding used here. */
export interface DurableObjectNamespaceLike {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(input: string, init?: RequestInit): Promise<Response> };
}

export interface CoordinatorClient {
  ingest(message: IngestMessage): Promise<IngestOutcome>;
  ensure(repo: RepoRef, branch: string): Promise<IngestOutcome>;
  reconcile(repo: RepoRef): Promise<ReconcileOutcome>;
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
    ensure: (repo, branch) => call("/ensure", { repo, branch }),
    reconcile: (repo) => call("/reconcile", { repo }),
  };
}

/**
 * First view of a branch nobody has ingested: concurrent readers in one
 * isolate share one Durable Object call, and the Durable Object shares one
 * ingest across isolates. (Wired into the serving path in P4.)
 */
export function firstViewEnsurer(clientFor: (repoId: number) => CoordinatorClient): (repo: RepoRef, branch: string) => Promise<IngestOutcome> {
  const flights = new SingleFlight<IngestOutcome>();
  return (repo, branch) => flights.run(`${repo.id}:${branch}`, () => clientFor(repo.id).ensure(repo, branch));
}
