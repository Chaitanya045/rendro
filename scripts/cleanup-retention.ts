import { DeleteObjectsCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import { pathToFileURL } from "node:url";

type Claim = { _id: string; organizationId: string; projectId: string; purgeToken: string };

export async function main(): Promise<void> {
  const site = process.env.CONVEX_SITE_URL;
  const secret = process.env.RETENTION_SECRET;
  if (!site || !secret) throw new Error("CONVEX_SITE_URL and RETENTION_SECRET are required");
  const bucket = process.env.MINIO_BUCKET ?? "docs";
  const s3 = new S3Client({
    endpoint: process.env.MINIO_ENDPOINT,
    region: process.env.MINIO_REGION ?? "us-east-1",
    credentials: process.env.MINIO_ACCESS_KEY && process.env.MINIO_SECRET_KEY ? {
      accessKeyId: process.env.MINIO_ACCESS_KEY, secretAccessKey: process.env.MINIO_SECRET_KEY,
    } : undefined,
    forcePathStyle: process.env.MINIO_FORCE_PATH_STYLE !== "false",
  });
  // Bound pages as well as wall time; a single huge deployment can resume on the
  // next run. Claims remain purging after any interruption or partial failure.
  const deadline = Date.now() + 10 * 60 * 1000;
  let storagePages = 0;
  let purged = 0;
  let failures = 0;
  async function requestJson<T>(path: string, body?: object): Promise<T> {
    const response = await fetch(`${site}${path}`, {
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
      if (Date.now() >= deadline || storagePages >= 1_000) throw new Error("Retention storage budget reached");
      storagePages++;
      // Re-list from the beginning after each successful delete. This is safe
      // across restarts and does not depend on cursors over a shrinking key set.
      const page = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, MaxKeys: 1000 }), { abortSignal: AbortSignal.timeout(30_000) });
      const objects = (page.Contents ?? []).flatMap(object => object.Key ? [{ Key: object.Key }] : []);
      if (!objects.length) {
        if (page.IsTruncated) throw new Error("Truncated empty storage page");
        return count;
      }
      const result = await s3.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: objects, Quiet: true } }), { abortSignal: AbortSignal.timeout(30_000) });
      if (result.Errors?.length) throw new Error(`Storage deletion failed for ${result.Errors.length} objects`);
      count += objects.length;
    }
  }
  try {
    for (let batch = 0; batch < 100 && Date.now() < deadline && storagePages < 1_000; batch++) {
      const result = await requestJson<{ deployments: Claim[]; cycleComplete: boolean }>("/api/rendro/retention/candidates");
      for (const deployment of result.deployments) {
        try {
          const objectCount = await deletePrefix(deployment);
          const finalized = await requestJson<{ purged: boolean }>("/api/rendro/retention/purged", {
            deploymentId: deployment._id, purgeToken: deployment.purgeToken, objectCount,
          });
          if (!finalized.purged) throw new Error("Purge claim was replaced");
          purged++;
          console.log(`Purged ${deployment._id}: ${objectCount} objects`);
        } catch (error) {
          failures++;
          console.error(`Retention retry required for ${deployment._id}: ${String(error)}`);
        }
      }
      if (result.cycleComplete) break;
    }
  } finally {
    s3.destroy();
  }
  console.log(`Retention complete: ${purged} deployments; ${failures} retries required`);
  if (failures) throw new Error("Some deployments remain claimed for retry");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
