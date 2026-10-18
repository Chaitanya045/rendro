import { CONVEX_SITE_URL, RETENTION_SECRET } from "@/config";
import { logger } from "@/logger";
import { deleteObjects, listKeyPage } from "@/storage";

type Claim = { _id: string; organizationId: string; projectId: string; purgeToken: string };

const WALL_BUDGET_MS = 10 * 60 * 1000;
const MAX_CANDIDATE_BATCHES = 100;
const PAGE_SIZE = 1000;
// One invocation may make at most 1000 subrequests. Candidate, finalize, list and delete calls all
// count, so stop starting new work at 900 (a started list/delete/finalize adds at most three more);
// claims remain purging and the next scheduled run resumes them.
const MAX_OPERATIONS = 900;

/**
 * Deletes the objects of every deployment Convex has claimed for purging, then confirms each purge with
 * its claim token. Runs from the Worker's scheduled handler with the R2 binding, so no storage credential
 * exists anywhere. A claim whose deletion fails or is interrupted stays claimed and is retried by the
 * next run; deleting an already-deleted key is not an error.
 */
export async function purgeExpiredDeployments(): Promise<{ purged: number; failures: number }> {
  const secret = RETENTION_SECRET;
  if (!CONVEX_SITE_URL || !secret) {
    logger.error({ category: "RetentionDisabled" }, "Retention requires CONVEX_SITE_URL and RETENTION_SECRET");
    throw new Error("CONVEX_SITE_URL and RETENTION_SECRET are required");
  }
  const deadline = Date.now() + WALL_BUDGET_MS;
  let operations = 0;
  let purged = 0;
  let failures = 0;
  const hasBudget = () => Date.now() < deadline && operations < MAX_OPERATIONS;

  async function requestJson<T>(path: string, body?: object): Promise<T> {
    operations++;
    const response = await fetch(`${CONVEX_SITE_URL}${path}`, {
      method: body ? "POST" : "GET",
      headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`Retention HTTP ${response.status}`);
    return response.json() as Promise<T>;
  }

  async function deletePrefix(claim: Claim): Promise<number> {
    // Derive the exact immutable prefix from stored IDs, never manifestKey.
    const prefix = `tenants/${claim.organizationId}/projects/${claim.projectId}/deployments/${claim._id}/`;
    let count = 0;
    for (;;) {
      if (!hasBudget()) throw new Error("Retention storage budget reached");
      // Re-list from the beginning after each successful delete. This is safe
      // across restarts and does not depend on cursors over a shrinking key set.
      operations++;
      const page = await listKeyPage(prefix, PAGE_SIZE);
      if (!page.keys.length) {
        if (page.truncated) throw new Error("Truncated empty storage page");
        return count;
      }
      operations++;
      await deleteObjects(page.keys);
      count += page.keys.length;
    }
  }

  for (let batch = 0; batch < MAX_CANDIDATE_BATCHES && hasBudget(); batch++) {
    const result = await requestJson<{ deployments: Claim[]; cycleComplete: boolean }>("/api/rendro/retention/candidates");
    for (const deployment of result.deployments) {
      try {
        const objectCount = await deletePrefix(deployment);
        const finalized = await requestJson<{ purged: boolean }>("/api/rendro/retention/purged", {
          deploymentId: deployment._id, purgeToken: deployment.purgeToken, objectCount,
        });
        if (!finalized.purged) throw new Error("Purge claim was replaced");
        purged++;
        logger.info({ deploymentId: deployment._id, objectCount }, "Retention purged deployment");
      } catch (error) {
        failures++;
        logger.error({ category: "RetentionRetry", deploymentId: deployment._id, errorType: error instanceof Error ? error.name : typeof error }, "Retention retry required");
      }
    }
    if (result.cycleComplete) break;
  }
  logger.info({ purged, failures }, "Retention complete");
  if (failures) throw new Error("Some deployments remain claimed for retry");
  return { purged, failures };
}
