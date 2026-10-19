/**
 * Where the control Worker deletes a removed repository's cached content
 * (#263): R2 objects and search rows, through the repository's own ingest
 * coordinator (the ingest Worker's `RepoIngestCoordinator`, bound here as
 * `REPO_INGEST`), so a purge is serialized with that repository's ingests.
 * Called only after GitHub confirmed the removal (#258). "Accepted" means the
 * coordinator recorded the purge durably and continues it from its alarm;
 * anything else throws, so the purge ledger asks GitHub again later.
 */
import { coordinatorClient, type DurableObjectNamespaceLike } from "@/ingest/orchestrator/coordinator-client";
import type { ContentPurgeSink } from "./directory";

export function coordinatorContentPurge(namespace: DurableObjectNamespaceLike): ContentPurgeSink {
  return {
    async purge(repoIds) {
      const outcomes = await Promise.all(repoIds.map(id => coordinatorClient(namespace, id).purge(id)));
      if (outcomes.some(outcome => outcome.status !== "done" && outcome.status !== "accepted")) throw new Error("A content purge was refused");
    },
  };
}
