import {
  GetObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from "@aws-sdk/client-s3";
import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

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

async function ensureProject(target: MigrationTarget, manifestSha256: string): Promise<{ _id: string; activeDeploymentId?: string }> {
  if (!migrationSecret) throw new Error("MIGRATION_SECRET is required with --apply");
  const slug = `legacy-${target.legacyOrgSlug}`.replace(/[^a-z0-9-]+/g, "-").slice(0, 48).replace(/-+$/, "");
  const result = await requestJson<{ project: { _id: string; activeDeploymentId?: string } }>(
    `${endpoint}/api/rendro/migration/project`,
    migrationSecret,
    {
      method: "POST",
      body: JSON.stringify({
        organizationId: target.organizationId,
        projectId: target.projectId,
        name: target.projectName ?? `Legacy ${target.legacyOrgSlug} docs`,
        slug,
        legacyOrgSlug: target.legacyOrgSlug,
        manifestSha256,
      }),
    },
  );
  return result.project;
}

async function migrateTarget(
  target: MigrationTarget,
  apply: boolean,
  checkpoint: (record: RollbackRecord) => Promise<void>,
): Promise<RollbackRecord> {
  const prefix = `${target.legacyOrgSlug}/`;
  const objects = await listLegacy(prefix);
  console.log(`${target.legacyOrgSlug}: ${objects.length} legacy objects`);
  console.log(`  ${prefix} → organization ${target.organizationId}, project ${target.projectId ?? `<new: legacy-${target.legacyOrgSlug}>`}`);
  console.log(`  Publications: ${target.legacyApiKey ? "recreate as pinned mappings" : "skip (no legacyApiKey)"}`);
  const rollback: RollbackRecord = {
    legacyOrgSlug: target.legacyOrgSlug,
    organizationId: target.organizationId,
    projectId: target.projectId ?? "<new project>",
    publicationIds: [],
  };
  if (!apply) return rollback;

  const files: ManifestEntry[] = [];
  for (const object of objects) files.push(await manifestEntry(object.key, prefix));
  // Match the Worker's code-point ordering, including mixed case paths.
  files.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  const manifest = { version: 1, files };
  const manifestText = JSON.stringify(manifest);
  const manifestSha256 = createHash("sha256").update(manifestText).digest("hex");
  const project = await ensureProject(target, manifestSha256);
  const projectId = project._id;
  rollback.projectId = projectId;
  await checkpoint(rollback);
  const identity = { organizationId: target.organizationId, projectId };
  const query = new URLSearchParams(identity);
  let deploymentId = project.activeDeploymentId;
  if (deploymentId) {
    console.log(`${target.legacyOrgSlug}: reusing completed migration ${deploymentId}`);
  } else {
    const started = await requestJson<{
      deployment: { deploymentId: string };
    }>(`${endpoint}/api/rendro/deployments/start`, target.apiKey, {
      method: "POST",
      body: JSON.stringify({
        organizationId: target.organizationId,
        projectId,
        manifest,
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
    deploymentId = started.deployment.deploymentId;
    rollback.deploymentId = deploymentId;
    const deploymentUrl = `${endpoint}/api/rendro/deployments/${encodeURIComponent(deploymentId)}`;
    try {
      await checkpoint(rollback);
      for (const file of files) {
        const object = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: prefix + file.path }));
        if (!object.Body) throw new Error(`Unable to read ${prefix + file.path}`);
        const bytes = await object.Body.transformToByteArray();
        const path = file.path.split("/").map(encodeURIComponent).join("/");
        const response = await fetch(`${deploymentUrl}/files/${path}?${query}`, {
          method: "PUT",
          headers: { Authorization: `Bearer ${target.apiKey}`, "Content-Type": file.contentType },
          body: Buffer.from(bytes),
        });
        if (!response.ok) throw new Error(`Upload failed for ${file.path}: ${response.status} ${await response.text()}`);
      }
      await requestJson(`${deploymentUrl}/commit?${query}`, target.apiKey, { method: "POST", body: "{}" });
    } catch (error) {
      await requestJson(`${endpoint}/api/rendro/deployments/fail`, target.apiKey, {
        method: "POST",
        body: JSON.stringify({ ...identity, deploymentId, reason: error instanceof Error ? error.message : String(error) }),
      }).catch(() => {});
      throw error;
    }
  }
  rollback.deploymentId = deploymentId;
  await checkpoint(rollback);

  if (target.legacyApiKey) {
    const legacy = await requestJson<{
      publications: Array<{ slug: string; sourcePrefix: string; entryFile: string; title: string }>;
    }>(`${endpoint}/api/publications`, target.legacyApiKey);
    const existing = await requestJson<{
      publications: Array<{ _id: string; slug: string; pathPrefix: string; entryFile: string; title: string; trackingMode: string; pinnedDeploymentId?: string }>;
    }>(`${endpoint}/api/rendro/publications?${query}`, target.apiKey);
    for (const publication of legacy.publications) {
      if (!publication.sourcePrefix.startsWith(prefix)) continue;
      const pathPrefix = publication.sourcePrefix.slice(prefix.length).replace(/\/$/, "");
      const previous = existing.publications.find((entry) => entry.slug === publication.slug);
      if (previous) {
        if (previous.pathPrefix !== pathPrefix || previous.entryFile !== publication.entryFile
          || previous.title !== publication.title || previous.trackingMode !== "pinned"
          || previous.pinnedDeploymentId !== deploymentId) {
          throw new Error(`Publication ${publication.slug} conflicts with the migration`);
        }
        rollback.publicationIds.push(previous._id);
        await checkpoint(rollback);
        continue;
      }
      const created = await requestJson<{ publication: { _id: string } }>(
        `${endpoint}/api/rendro/publications`,
        target.apiKey,
        {
          method: "POST",
          body: JSON.stringify({
            organizationId: target.organizationId,
            projectId,
            slug: publication.slug,
            pathPrefix,
            entryFile: publication.entryFile,
            title: publication.title,
            trackingMode: "pinned",
            pinnedDeploymentId: deploymentId,
          }),
        },
      );
      rollback.publicationIds.push(created.publication._id);
      await checkpoint(rollback);
    }
  }
  return rollback;
}

async function rollbackMigration(
  targets: MigrationTarget[],
  records: RollbackRecord[],
): Promise<void> {
  for (const record of [...records].reverse()) {
    const target = targets.find((candidate) => candidate.organizationId === record.organizationId
      && candidate.legacyOrgSlug === record.legacyOrgSlug);
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

export async function main(args = process.argv.slice(2)): Promise<void> {
  const apply = args.includes("--apply");
  const mapArg = args.indexOf("--map");
  const mapPath = mapArg >= 0 ? args[mapArg + 1] : undefined;
  if (!mapPath || mapPath.startsWith("--")) {
    throw new Error("Usage: migrate-legacy-tenancy --map <targets.json> [--apply [--rollback <record.json>]]");
  }
  const targets = JSON.parse(await readFile(mapPath, "utf8")) as MigrationTarget[];
  const rollbackArg = args.indexOf("--rollback");
  const rollbackPath = rollbackArg >= 0 ? args[rollbackArg + 1] : undefined;
  if (rollbackArg >= 0 && (!rollbackPath || rollbackPath.startsWith("--"))) {
    throw new Error("--rollback requires a record path");
  }
  if (rollbackPath) {
    if (!apply) throw new Error("--rollback changes publications and requires --apply");
    const records = JSON.parse(await readFile(rollbackPath, "utf8")) as RollbackRecord[];
    await rollbackMigration(targets, records);
    return;
  }
  if (apply && !migrationSecret) throw new Error("MIGRATION_SECRET is required with --apply");
  const rollback: RollbackRecord[] = [];
  const recordPath = `migration-rollback-${Date.now()}-${randomUUID()}.json`;
  if (apply) {
    await writeFile(recordPath, "[]\n", { flag: "wx", mode: 0o600 });
    console.log(`Rollback record (also preserved on failure): ${recordPath}`);
  }
  for (const target of targets) {
    await migrateTarget(target, apply, async (record) => {
      if (!rollback.includes(record)) rollback.push(record);
      await writeFile(recordPath, JSON.stringify(rollback, null, 2) + "\n");
    });
  }
  if (!apply) {
    console.log("Dry run only. Re-run with --apply after reviewing object counts and mappings.");
    return;
  }
  console.log(`Migration complete. Legacy objects and routes were not deleted. Rollback record: ${recordPath}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
