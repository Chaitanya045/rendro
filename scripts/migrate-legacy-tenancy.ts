import {
  GetObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from "@aws-sdk/client-s3";
import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { decodeStoragePath } from "../shared/storage-path";
import { cleanDeploymentPath, cleanPublicationPath } from "../shared/v2-paths";

interface MigrationTarget {
  legacyOrgSlug: string;
  organizationId: string;
  projectId?: string;
  projectName?: string;
  apiKey: string;
  legacySessionCookie?: string;
}

interface LegacyPublication {
  slug: string;
  sourcePrefix: string;
  entryFile: string;
  title: string;
}

// An unavailable deletion database must stop migration, never expose deleted files.
async function visibleLegacyKeys(keys: string[]): Promise<Set<string>> {
  const convexUrl = process.env.CONVEX_URL?.replace(/\/$/, "");
  const internalSecret = process.env.CONVEX_INTERNAL_SECRET;
  if (!convexUrl || !internalSecret) {
    throw new Error("Cannot establish legacy visibility: CONVEX_URL and CONVEX_INTERNAL_SECRET must identify the source deleted_files database");
  }
  const visible = new Set<string>();
  for (let offset = 0; offset < keys.length; offset += 100) {
    const batch = keys.slice(offset, offset + 100);
    try {
      const response = await fetch(`${convexUrl}/api/query`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "deletedFiles:filterFn", args: [{ keys: batch, internalSecret }] }),
        redirect: "error",
      });
      const result = await response.json() as { status?: unknown; value?: unknown } | null;
      if (!response.ok || result?.status !== "success" || !Array.isArray(result.value)
        || result.value.some(key => typeof key !== "string" || !batch.includes(key))) {
        throw new Error("Invalid deletion query result");
      }
      for (const key of result.value as string[]) visible.add(key);
    } catch {
      throw new Error("Cannot establish legacy visibility from deleted_files; refusing migration. Check the source CONVEX_URL and CONVEX_INTERNAL_SECRET");
    }
  }
  return visible;
}

async function legacyPublications(target: MigrationTarget): Promise<LegacyPublication[]> {
  if (!target.legacySessionCookie) return [];
  const response = await fetch(`${endpoint}/api/publications?${new URLSearchParams({ org: target.legacyOrgSlug })}`, {
    headers: { Cookie: target.legacySessionCookie }, redirect: "error",
  });
  if (!response.ok) throw new Error(`Legacy publication lookup failed (${response.status})`);
  const result = await response.json() as { publications: LegacyPublication[] };
  return result.publications.filter(publication => publication.sourcePrefix.startsWith(`${target.legacyOrgSlug}/`));
}

function canPublishLegacyPath(path: string): boolean {
  // v1 exposes only normalized HTML document paths. v2 serves any manifest
  // entry, including assets: conservatively exclude ambiguous encoded paths.
  return path === path.trim() && /\.html$/i.test(path) && !/[\\%\x00-\x1f]/.test(path)
    && path.split("/").every(part => part && part !== "." && part !== "..");
}

// Check the complete inventory, including deleted/private objects, before any
// destination write. Filtering first could hide an alias of a deleted path.
function validateLegacyPaths(prefix: string, keys: string[], publications: LegacyPublication[]) {
  const problems: string[] = [];
  const fileOrigins = new Map<string, Set<string>>();
  const prefixOrigins = new Map<string, Set<string>>();
  const check = (value: string, source: string, allowEmpty: boolean, origins?: Map<string, Set<string>>): string => {
    const publicationPath = cleanPublicationPath(value, allowEmpty);
    // Keep the pre-migration ambiguity check even though v2 JSON paths now
    // preserve percent signs. Decode only for refusal/collision diagnostics;
    // never use a changed identity for destination storage.
    const canonical = publicationPath === null || publicationPath === ""
      ? publicationPath : cleanDeploymentPath(publicationPath);
    const normalized = canonical === null || canonical === ""
      ? canonical : decodeStoragePath(canonical);
    if (normalized === null || normalized !== value) {
      problems.push(`${JSON.stringify(source)} → ${normalized === null ? "invalid v2 path" : JSON.stringify(normalized)}`);
    }
    if (normalized !== null && origins) {
      const sources = origins.get(normalized) ?? new Set<string>();
      sources.add(source);
      origins.set(normalized, sources);
    }
    return normalized ?? value;
  };
  const paths = new Map(keys.map(key => [key, check(key.slice(prefix.length), key, false, fileOrigins)]));
  const mappings = publications.map(publication => {
    // One terminal slash is the legacy folder delimiter, not part of the
    // folder name. Remove exactly that delimiter, then require an identity.
    if (!publication.sourcePrefix.endsWith("/")) {
      problems.push(`${JSON.stringify(publication.sourcePrefix)}: missing legacy folder delimiter`);
    }
    const relative = publication.sourcePrefix.slice(prefix.length, -1);
    const pathPrefix = check(relative, publication.sourcePrefix, true, prefixOrigins);
    const entryFile = check(publication.entryFile, `${publication.slug} entry: ${publication.entryFile}`, false);
    return { ...publication, pathPrefix, entryFile };
  });
  for (const origins of [fileOrigins, prefixOrigins]) {
    for (const [path, sources] of origins) {
      if (sources.size > 1) problems.push(`collision at ${JSON.stringify(path)}: ${[...sources].map(source => JSON.stringify(source)).join(", ")}`);
    }
  }
  if (problems.length) {
    throw new Error(`Unsafe legacy paths; refusing migration before destination writes (publications: ${publications.map(row => row.slug).join(", ") || "none"}):\n${problems.join("\n")}`);
  }
  return { paths, mappings };
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
const bucket = process.env.LEGACY_SOURCE_S3_BUCKET ?? "docs";
const s3 = new S3Client({
  endpoint: process.env.LEGACY_SOURCE_S3_ENDPOINT,
  region: process.env.LEGACY_SOURCE_S3_REGION ?? "us-east-1",
  credentials: process.env.LEGACY_SOURCE_S3_ACCESS_KEY && process.env.LEGACY_SOURCE_S3_SECRET_KEY ? {
    accessKeyId: process.env.LEGACY_SOURCE_S3_ACCESS_KEY,
    secretAccessKey: process.env.LEGACY_SOURCE_S3_SECRET_KEY,
  } : undefined,
  forcePathStyle: process.env.LEGACY_SOURCE_S3_FORCE_PATH_STYLE !== "false",
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

async function manifestEntry(key: string, path: string): Promise<ManifestEntry> {
  const object = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  if (!object.Body) throw new Error(`Unable to read ${key}`);
  const bytes = await object.Body.transformToByteArray();
  return {
    path,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    size: bytes.byteLength,
    contentType: object.ContentType ?? "application/octet-stream",
  };
}

async function ensureProject(target: MigrationTarget, manifestSha256: string): Promise<{ _id: string; activeDeploymentId?: string }> {
  const slug = `legacy-${target.legacyOrgSlug}`.replace(/[^a-z0-9-]+/g, "-").slice(0, 48).replace(/-+$/, "");
  const result = await requestJson<{ project: { _id: string; activeDeploymentId?: string } }>(
    `${endpoint}/api/rendro/migration/project`,
    migrationSecret!, // main rejects missing credentials before any apply work.
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
  console.log(`  Publications: ${target.legacySessionCookie ? "recreate as pinned mappings" : "skip (no legacySessionCookie)"}`);
  const rollback: RollbackRecord = {
    legacyOrgSlug: target.legacyOrgSlug,
    organizationId: target.organizationId,
    projectId: target.projectId ?? "<new project>",
    publicationIds: [],
  };
  if (!apply) return rollback;

  const keys = objects.map(object => object.key);
  const visible = await visibleLegacyKeys(keys);
  const legacy = await legacyPublications(target);
  const { paths, mappings } = validateLegacyPaths(prefix, keys, legacy);
  const visiblePaths = new Set([...visible].map(key => paths.get(key)!));
  const included = objects.filter(object => {
    const path = paths.get(object.key)!;
    return visiblePaths.has(path) && mappings.every(publication => {
      const folder = publication.pathPrefix ? `${publication.pathPrefix}/` : "";
      return !path.startsWith(folder) || canPublishLegacyPath(path.slice(folder.length));
    });
  });
  console.log(`  Excluded ${objects.length - included.length} deleted or legacy-inaccessible objects`);
  for (const publication of mappings) {
    const entry = publication.pathPrefix ? `${publication.pathPrefix}/${publication.entryFile}` : publication.entryFile;
    if (!included.some(object => paths.get(object.key) === entry)) {
      throw new Error(`Publication ${publication.slug} has no visible entry document; refusing migration`);
    }
  }
  const files: ManifestEntry[] = [];
  for (const object of included) files.push(await manifestEntry(object.key, paths.get(object.key)!));
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
      deployment: { deploymentId: string; previousDeploymentId?: string };
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
      // The project can gain an active deployment after ensureProject checks it.
      // Never let migration replace that work, even if start would permit it.
      if (started.deployment.previousDeploymentId) {
        throw new Error("Migration project gained an active deployment; retry after reviewing the destination");
      }
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

  if (target.legacySessionCookie) {
    // Recheck before making anything public. Operators must freeze legacy
    // content, deletion, and publication writes for the entire migration.
    const currentVisible = await visibleLegacyKeys(keys);
    const currentPublications = await legacyPublications(target);
    if (keys.some(key => currentVisible.has(key) !== visible.has(key))
      || JSON.stringify(currentPublications) !== JSON.stringify(legacy)) {
      throw new Error("Legacy visibility changed during migration; refusing publication. Freeze legacy writes and review the destination before retrying");
    }
    const existing = await requestJson<{
      publications: Array<{ _id: string; slug: string; pathPrefix: string; entryFile: string; title: string; trackingMode: string; pinnedDeploymentId?: string }>;
    }>(`${endpoint}/api/rendro/publications?${query}`, target.apiKey);
    for (const publication of mappings) {
      const { pathPrefix } = publication;
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

function sanitizedOrigin(value: string | undefined, fallback: string): string {
  if (!value) return fallback;
  try { return new URL(value).origin; } catch { return "<invalid endpoint>"; }
}

function printEnvironment(targets: MigrationTarget[], records?: RollbackRecord[]): void {
  console.log(`Destination Worker: ${sanitizedOrigin(endpoint, "<unset>")}`);
  console.log(`Source storage: ${sanitizedOrigin(process.env.LEGACY_SOURCE_S3_ENDPOINT, `AWS SDK default (region ${process.env.LEGACY_SOURCE_S3_REGION ?? "us-east-1"})`)}; bucket: ${bucket}`);
  console.log(`Source legacy Convex: ${sanitizedOrigin(process.env.CONVEX_URL, "<unset>")}`);
  for (const target of records ?? targets) {
    console.log(`  ${target.legacyOrgSlug}/ → organization ${target.organizationId}, project ${target.projectId ?? `<new: legacy-${target.legacyOrgSlug}>`}`);
  }
}

function confirmDestination(args: string[]): void {
  const destination = new URL(endpoint);
  if (["localhost", "127.0.0.1", "[::1]"].includes(destination.hostname)) return;
  const index = args.indexOf("--confirm-endpoint");
  if (index < 0 || args[index + 1] !== destination.origin) {
    throw new Error(`Non-local writes require --confirm-endpoint ${destination.origin} after reviewing the source and destination summary`);
  }
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  const apply = args.includes("--apply");
  const mapArg = args.indexOf("--map");
  const mapPath = mapArg >= 0 ? args[mapArg + 1] : undefined;
  if (!mapPath || mapPath.startsWith("--")) {
    throw new Error("Usage: migrate-legacy-tenancy --map <targets.json> [--apply [--confirm-endpoint <origin>] [--rollback <record.json>]]");
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
    printEnvironment(targets, records);
    confirmDestination(args);
    await rollbackMigration(targets, records);
    return;
  }
  printEnvironment(targets);
  if (apply) confirmDestination(args);
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
