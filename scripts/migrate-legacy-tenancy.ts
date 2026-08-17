import {
  CopyObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

interface MigrationTarget {
  legacyOrgSlug: string;
  organizationId: string;
  projectId?: string;
  projectName?: string;
  apiKey: string;
  legacyApiKey?: string;
}

interface ManifestEntry {
  path: string;
  sha256: string;
  size: number;
  contentType: string;
}

interface RollbackRecord {
  legacyOrgSlug: string;
  organizationId: string;
  projectId: string;
  deploymentId?: string;
  publicationIds: string[];
}

const endpoint = (process.env.RENDRO_ENDPOINT ?? "http://localhost:3000").replace(/\/$/, "");
const migrationSecret = process.env.MIGRATION_SECRET;
const bucket = process.env.MINIO_BUCKET ?? "docs";
const s3 = new S3Client({
  endpoint: process.env.MINIO_ENDPOINT,
  region: process.env.MINIO_REGION ?? "us-east-1",
  credentials: process.env.MINIO_ACCESS_KEY && process.env.MINIO_SECRET_KEY ? {
    accessKeyId: process.env.MINIO_ACCESS_KEY,
    secretAccessKey: process.env.MINIO_SECRET_KEY,
  } : undefined,
  forcePathStyle: process.env.MINIO_FORCE_PATH_STYLE !== "false",
});

async function requestJson<T>(url: string, key: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  headers.set("Authorization", `Bearer ${key}`);
  if (init?.body) headers.set("Content-Type", "application/json");
  const response = await fetch(url, { ...init, headers });
  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
  return response.json() as Promise<T>;
}

async function listLegacy(prefix: string): Promise<Array<{ key: string; size: number }>> {
  const output: Array<{ key: string; size: number }> = [];
  let continuationToken: string | undefined;
  do {
    const result = await s3.send(new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: prefix,
      ContinuationToken: continuationToken,
    }));
    for (const object of result.Contents ?? []) {
      if (object.Key && typeof object.Size === "number") output.push({ key: object.Key, size: object.Size });
    }
    continuationToken = result.NextContinuationToken;
  } while (continuationToken);
  return output;
}

async function manifestEntry(key: string, prefix: string): Promise<ManifestEntry> {
  const object = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  if (!object.Body) throw new Error(`Unable to read ${key}`);
  const bytes = await object.Body.transformToByteArray();
  return {
    path: key.slice(prefix.length),
    sha256: createHash("sha256").update(bytes).digest("hex"),
    size: bytes.byteLength,
    contentType: object.ContentType ?? "application/octet-stream",
  };
}

async function ensureProject(target: MigrationTarget): Promise<string> {
  if (!migrationSecret) throw new Error("MIGRATION_SECRET is required with --apply");
  const slug = `legacy-${target.legacyOrgSlug}`.replace(/[^a-z0-9-]+/g, "-").slice(0, 48);
  const result = await requestJson<{ project: { _id: string } }>(
    `${endpoint}/api/rendro/migration/project`,
    migrationSecret,
    {
      method: "POST",
      body: JSON.stringify({
        organizationId: target.organizationId,
        projectId: target.projectId,
        name: target.projectName ?? `Legacy ${target.legacyOrgSlug} docs`,
        slug,
      }),
    },
  );
  return result.project._id;
}

async function migrateTarget(target: MigrationTarget, apply: boolean): Promise<RollbackRecord> {
  const prefix = `${target.legacyOrgSlug}/`;
  const objects = await listLegacy(prefix);
  console.log(`${target.legacyOrgSlug}: ${objects.length} legacy objects`);
  const projectId = apply ? await ensureProject(target) : target.projectId ?? "<new project>";
  const rollback: RollbackRecord = {
    legacyOrgSlug: target.legacyOrgSlug,
    organizationId: target.organizationId,
    projectId,
    publicationIds: [],
  };
  if (!apply) return rollback;

  const files: ManifestEntry[] = [];
  for (const object of objects) files.push(await manifestEntry(object.key, prefix));
  files.sort((left, right) => left.path.localeCompare(right.path));
  const manifestText = JSON.stringify({ version: 1, files });
  const manifestSha256 = createHash("sha256").update(manifestText).digest("hex");
  const started = await requestJson<{
    deployment: { _id: string; manifestKey: string };
    unchanged: Array<{ path: string }>;
  }>(`${endpoint}/api/rendro/deployments/start`, target.apiKey, {
    method: "POST",
    body: JSON.stringify({
      organizationId: target.organizationId,
      projectId,
      manifestSha256,
      fileCount: files.length,
      byteCount: files.reduce((sum, file) => sum + file.size, 0),
      provenance: {
        source: { kind: "local", localPathLabel: `legacy:${target.legacyOrgSlug}` },
        execution: { kind: "local", actor: "migration" },
        cliVersion: "migration-1",
        manifestSha256,
      },
    }),
  });
  rollback.deploymentId = started.deployment._id;
  const destinationPrefix = started.deployment.manifestKey.slice(0, -"manifest.json".length) + "files/";
  const unchanged = new Set(started.unchanged.map((entry) => entry.path));
  for (const file of files) {
    if (unchanged.has(file.path)) continue;
    await s3.send(new CopyObjectCommand({
      Bucket: bucket,
      CopySource: `${bucket}/${encodeURIComponent(prefix + file.path).replaceAll("%2F", "/")}`,
      Key: destinationPrefix + file.path,
      ContentType: file.contentType,
      MetadataDirective: "REPLACE",
    }));
  }
  await s3.send(new PutObjectCommand({
    Bucket: bucket,
    Key: started.deployment.manifestKey,
    Body: manifestText,
    ContentType: "application/json; charset=utf-8",
  }));
  await requestJson(`${endpoint}/api/rendro/deployments/commit`, target.apiKey, {
    method: "POST",
    body: JSON.stringify({ organizationId: target.organizationId, projectId, deploymentId: started.deployment._id }),
  });

  if (target.legacyApiKey) {
    const legacy = await requestJson<{
      publications: Array<{ slug: string; sourcePrefix: string; entryFile: string; title: string }>;
    }>(`${endpoint}/api/publications`, target.legacyApiKey);
    for (const publication of legacy.publications) {
      if (!publication.sourcePrefix.startsWith(prefix)) continue;
      const created = await requestJson<{ publication: { _id: string } }>(
        `${endpoint}/api/rendro/publications`,
        target.apiKey,
        {
          method: "POST",
          body: JSON.stringify({
            organizationId: target.organizationId,
            projectId,
            slug: publication.slug,
            pathPrefix: publication.sourcePrefix.slice(prefix.length).replace(/\/$/, ""),
            entryFile: publication.entryFile,
            title: publication.title,
            trackingMode: "pinned",
            pinnedDeploymentId: started.deployment._id,
          }),
        },
      );
      rollback.publicationIds.push(created.publication._id);
    }
  }
  return rollback;
}

async function rollbackMigration(
  targets: MigrationTarget[],
  records: RollbackRecord[],
): Promise<void> {
  for (const record of [...records].reverse()) {
    const target = targets.find((candidate) => candidate.organizationId === record.organizationId);
    if (!target) throw new Error(`Missing target credentials for ${record.organizationId}`);
    for (const publicationId of [...record.publicationIds].reverse()) {
      await requestJson(`${endpoint}/api/rendro/publications/remove`, target.apiKey, {
        method: "POST",
        body: JSON.stringify({
          organizationId: record.organizationId,
          projectId: record.projectId,
          publicationId,
        }),
      });
      console.log(`Removed migrated publication ${publicationId}`);
    }
  }
  console.log("Rollback complete. Migrated projects and objects remain private for audit; legacy data was never changed.");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const mapArg = args.indexOf("--map");
  const mapPath = mapArg >= 0 ? args[mapArg + 1] : undefined;
  if (!mapPath) {
    throw new Error("Usage: migrate-legacy-tenancy --map <targets.json> [--apply | --rollback <record.json>]");
  }
  const targets = JSON.parse(await readFile(mapPath, "utf8")) as MigrationTarget[];
  const rollbackArg = args.indexOf("--rollback");
  const rollbackPath = rollbackArg >= 0 ? args[rollbackArg + 1] : undefined;
  if (rollbackPath) {
    const records = JSON.parse(await readFile(rollbackPath, "utf8")) as RollbackRecord[];
    await rollbackMigration(targets, records);
    return;
  }
  const rollback: RollbackRecord[] = [];
  for (const target of targets) rollback.push(await migrateTarget(target, apply));
  if (!apply) {
    console.log("Dry run only. Re-run with --apply after reviewing object counts and mappings.");
    return;
  }
  const recordPath = `migration-rollback-${Date.now()}.json`;
  await writeFile(recordPath, JSON.stringify(rollback, null, 2) + "\n");
  console.log(`Migration complete. Legacy objects and routes were not deleted. Rollback record: ${recordPath}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
