import { DeleteObjectsCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";

const site = process.env.CONVEX_SITE_URL;
const secret = process.env.RETENTION_SECRET;
const bucket = process.env.MINIO_BUCKET ?? "docs";
if (!site || !secret) throw new Error("CONVEX_SITE_URL and RETENTION_SECRET are required");

const s3 = new S3Client({
  endpoint: process.env.MINIO_ENDPOINT,
  region: process.env.MINIO_REGION ?? "us-east-1",
  credentials: process.env.MINIO_ACCESS_KEY && process.env.MINIO_SECRET_KEY ? {
    accessKeyId: process.env.MINIO_ACCESS_KEY,
    secretAccessKey: process.env.MINIO_SECRET_KEY,
  } : undefined,
  forcePathStyle: process.env.MINIO_FORCE_PATH_STYLE !== "false",
});

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  headers.set("Authorization", `Bearer ${secret}`);
  if (init?.body) headers.set("Content-Type", "application/json");
  const response = await fetch(`${site}${path}`, { ...init, headers });
  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
  return response.json() as Promise<T>;
}

async function deletePrefix(prefix: string): Promise<number> {
  let count = 0;
  let continuationToken: string | undefined;
  do {
    const page = await s3.send(new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: prefix,
      ContinuationToken: continuationToken,
    }));
    const objects = (page.Contents ?? []).flatMap((object) => object.Key ? [{ Key: object.Key }] : []);
    if (objects.length) {
      await s3.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: objects, Quiet: true } }));
      count += objects.length;
    }
    continuationToken = page.NextContinuationToken;
  } while (continuationToken);
  return count;
}

async function main(): Promise<void> {
  const result = await requestJson<{
    deployments: Array<{ _id: string; manifestKey: string; status: string }>;
  }>("/api/rendro/retention/candidates");
  for (const deployment of result.deployments) {
    const prefix = deployment.manifestKey.slice(0, -"manifest.json".length);
    const objectCount = await deletePrefix(prefix);
    await requestJson("/api/rendro/retention/purged", {
      method: "POST",
      body: JSON.stringify({ deploymentId: deployment._id, objectCount }),
    });
    console.log(`Purged ${deployment._id}: ${objectCount} objects`);
  }
  console.log(`Retention complete: ${result.deployments.length} deployments`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
