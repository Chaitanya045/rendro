#!/usr/bin/env node
/**
 * rendro CLI — deploy and publish HTML documentation.
 *
 * Usage:
 *   rendro push --source ./docs --organization <id> --project <id>
 *   rendro publication create --organization <id> --project <id> --slug product
 *   rendro publication list --organization <id> --project <id>
 *   rendro publication remove --organization <id> --project <id> --id <publication-id>
 *   rendro init --source ./docs
 */
import { sanitizeProvenance } from "../../shared/provenance";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { cleanDeploymentPath, cleanPublicationPath } from "../../shared/v2-paths";
import { MAX_REUSED_FILES_PER_REQUEST } from "../../shared/deployment-limits";
import { version } from "../../package.json";
import { fetchWithRateLimit } from "./rate-limit";
import { httpErrorMessage } from "./http-error";
import { contentType } from "./content-type";
import { sourceFiles } from "./source-files";

interface PushOptions {
  source: string;
  organizationId: string;
  projectId: string;
  endpoint: string;
  token: string;
  concurrency?: number;
  includeSensitive: boolean;
}


interface FileEntry {
  fullPath: string;
  path: string;
  sha256: string;
  size: number;
  contentType: string;
}

type ManifestFile = Omit<FileEntry, "fullPath">;

function sha256(content: string | Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

function gitValue(cwd: string, args: string[], trim = true): string | undefined {
  try {
    const output = execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    // Preserve configured remote bytes for validation; remove only Git's output terminator.
    return (trim ? output.trim() : output.replace(/\n$/, "")) || undefined;
  } catch {
    return undefined;
  }
}

function deploymentProvenance(source: string, manifestSha256: string) {
  const commit = process.env.GITHUB_SHA || gitValue(source, ["rev-parse", "HEAD"]);
  const repository = process.env.GITHUB_REPOSITORY
    ? `https://github.com/${process.env.GITHUB_REPOSITORY}`
    : gitValue(source, ["config", "--get", "remote.origin.url"], false);
  const dirtyOutput = gitValue(source, ["status", "--porcelain"]);
  const ci = Boolean(process.env.CI);
  return sanitizeProvenance({
    source: commit
      ? {
          kind: "git" as const,
          repository,
          commit,
          ref: process.env.GITHUB_REF || gitValue(source, ["rev-parse", "--abbrev-ref", "HEAD"]),
          dirty: dirtyOutput ? true : false,
        }
      : { kind: "local" as const, localPathLabel: source },
    execution: ci
      ? {
          kind: "ci" as const,
          provider: process.env.GITHUB_ACTIONS ? "github-actions" : "ci",
          runId: process.env.GITHUB_RUN_ID,
          workflow: process.env.GITHUB_WORKFLOW,
          job: process.env.GITHUB_JOB,
          actor: process.env.GITHUB_ACTOR,
        }
      : { kind: "local" as const, actor: process.env.USER },
    cliVersion: version,
    manifestSha256,
  });
}

async function requestJson<T>(url: string, token: string, init?: RequestInit, idempotent?: boolean): Promise<T> {
  const headers = new Headers(init?.headers);
  headers.set("Authorization", `Bearer ${token}`);
  const res = await fetchWithRateLimit(url, { ...init, headers }, idempotent);
  if (!res.ok) throw new Error(await httpErrorMessage(res));
  return await res.json() as T;
}

type PublicationCommandOptions = {
  organizationId: string;
  projectId: string;
  endpoint: string;
  token: string;
};

async function createPublication(
  opts: PublicationCommandOptions & {
    slug: string;
    pathPrefix: string;
    entryFile: string;
    title: string;
    trackingMode: "track_active" | "pinned";
    pinnedDeploymentId?: string;
  },
): Promise<void> {
  const pathPrefix = cleanPublicationPath(opts.pathPrefix, true);
  const entryFile = cleanPublicationPath(opts.entryFile, false);
  if (pathPrefix === null || entryFile === null) throw new Error("Invalid publication path");
  const response = await requestJson<{ publication: { slug: string }; url: string }>(
    `${opts.endpoint.replace(/\/$/, "")}/api/rendro/publications`,
    opts.token,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        organizationId: opts.organizationId,
        projectId: opts.projectId,
        slug: opts.slug,
        pathPrefix,
        entryFile,
        title: opts.title,
        trackingMode: opts.trackingMode,
        pinnedDeploymentId: opts.pinnedDeploymentId,
      }),
    },
  );
  console.log(`Published ${response.publication.slug}: ${new URL(response.url, opts.endpoint).toString()}`);
}

async function listProjectPublications(opts: PublicationCommandOptions): Promise<void> {
  const endpoint = opts.endpoint.replace(/\/$/, "");
  const query = new URLSearchParams({
    organizationId: opts.organizationId,
    projectId: opts.projectId,
  });
  const result = await requestJson<{
    publications: Array<{ _id: string; slug: string; title?: string; trackingMode: string }>;
  }>(`${endpoint}/api/rendro/publications?${query}`, opts.token);
  if (!result.publications.length) {
    console.log("No publications.");
    return;
  }
  for (const publication of result.publications) {
    console.log(`${publication._id}  ${publication.slug}  ${publication.trackingMode}  ${publication.title ?? ""}`);
  }
}

async function removePublication(
  opts: PublicationCommandOptions & { publicationId: string },
): Promise<void> {
  await requestJson(
    `${opts.endpoint.replace(/\/$/, "")}/api/rendro/publications/remove`,
    opts.token,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        organizationId: opts.organizationId,
        projectId: opts.projectId,
        publicationId: opts.publicationId,
      }),
    },
  );
  console.log(`Removed publication ${opts.publicationId}`);
}


async function push(opts: PushOptions): Promise<void> {
  const {
    source,
    organizationId,
    projectId,
    endpoint,
    token,
    concurrency = 8,
  } = opts;
  const cleanEndpoint = endpoint.replace(/\/$/, "");
  const absSource = resolve(source);
  console.log(`→ Preparing ${source} for project ${projectId}`);

  const files = await sourceFiles(absSource, opts.includeSensitive, (path, reason) => {
    console.log(`  skipped ${JSON.stringify(path)} (${reason})`);
  });
  const entries: FileEntry[] = [];
  for (const fullPath of files) {
    const bytes = await readFile(fullPath);
    const relativePath = relative(absSource, fullPath).split(sep).join("/");
    const path = cleanDeploymentPath(relativePath);
    if (path === null) throw new Error(`Invalid deployment path: ${JSON.stringify(relativePath)}`);
    entries.push({
      fullPath,
      path,
      sha256: sha256(bytes),
      size: bytes.byteLength,
      contentType: contentType(path, bytes),
    });
  }
  // Match the server manifest ordering without locale-dependent comparisons.
  entries.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  const manifest = {
    version: 1 as const,
    files: entries.map(({ path, sha256: hash, size, contentType: type }) => ({
      path,
      sha256: hash,
      size,
      contentType: type,
    })),
  };
  const manifestText = JSON.stringify(manifest);
  const manifestSha256 = sha256(manifestText);
  const identityQuery = new URLSearchParams({ organizationId, projectId });

  const active = await requestJson<{
    deployment: { _id: string } | null;
    manifest: { files: ManifestFile[] } | null;
  }>(
    `${cleanEndpoint}/api/rendro/deployments/check?${identityQuery}`,
    token,
  );
  const activeByPath = new Map(
    (active.manifest?.files ?? []).map((entry) => [entry.path, entry]),
  );
  const unchanged = entries.filter((entry) => {
    const previous = activeByPath.get(entry.path);
    return previous?.sha256 === entry.sha256 && previous.size === entry.size;
  });
  const unchangedPaths = new Set(unchanged.map((entry) => entry.path));
  const changed = entries.filter((entry) => !unchangedPaths.has(entry.path));

  const started = await requestJson<{
    deployment: {
      deploymentId: string;
      previousDeploymentId?: string;
    };
  }>(
    `${cleanEndpoint}/api/rendro/deployments/start`,
    token,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        organizationId,
        projectId,
        manifest,
        manifestSha256,
        provenance: deploymentProvenance(absSource, manifestSha256),
      }),
    },
  );
  const deploymentId = started.deployment.deploymentId;
  const deploymentQuery = new URLSearchParams({
    organizationId,
    projectId,
  });
  const encodedDeploymentId = encodeURIComponent(deploymentId);

  try {
    if (unchanged.length > 0) {
      for (let start = 0; start < unchanged.length; start += MAX_REUSED_FILES_PER_REQUEST) {
        const paths = unchanged.slice(start, start + MAX_REUSED_FILES_PER_REQUEST).map((entry) => entry.path);
        await requestJson<{ copied: number }>(
          `${cleanEndpoint}/api/rendro/deployments/${encodedDeploymentId}/copy?${deploymentQuery}`,
          token,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ paths }),
          },
          true, // Re-copying immutable manifest files to the same staging keys is safe.
        );
      }
    }

    const upload = async (entry: FileEntry) => {
      const encodedPath = entry.path.split("/").map(encodeURIComponent).join("/");
      const bytes = await readFile(entry.fullPath);
      const response = await fetchWithRateLimit(
        `${cleanEndpoint}/api/rendro/deployments/${encodedDeploymentId}/files/${encodedPath}?${deploymentQuery}`,
        {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": entry.contentType,
          },
          body: bytes,
        },
        true, // Replay the same bytes to the same manifest-checked object key.
      );
      if (!response.ok) {
        throw new Error(`Upload failed for ${entry.path}: ${await httpErrorMessage(response)}`);
      }
      console.log(`  ↑ ${entry.path}`);
    };
    for (let start = 0; start < changed.length; start += concurrency) {
      await Promise.all(changed.slice(start, start + concurrency).map(upload));
    }

    await requestJson<{ deploymentId: string }>(
      `${cleanEndpoint}/api/rendro/deployments/${encodedDeploymentId}/commit?${deploymentQuery}`,
      token,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      },
    );
  } catch (error: unknown) {
    await requestJson<{ status: boolean }>(
      `${cleanEndpoint}/api/rendro/deployments/fail`,
      token,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          organizationId,
          projectId,
          deploymentId,
          reason: error instanceof Error ? error.message : String(error),
        }),
      },
      true, // Marking a staging deployment failed is idempotent.
    ).catch((cleanupError: unknown) => {
      const original = error instanceof Error ? error.message : String(error);
      const cleanup = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
      throw new Error(`${original}\nFailed to mark deployment ${deploymentId} as failed: ${cleanup}. It may remain staging; retry deployment cleanup.`, { cause: cleanupError });
    });
    throw error;
  }

  console.log("");
  console.log(`✓ Deployment active: ${deploymentId}`);
  console.log(`  ${changed.length} uploaded, ${unchanged.length} reused, ${entries.length} total`);
}


async function init(source: string): Promise<void> {
  const absSource = resolve(source);
  const dirs = [
    absSource,
    join(absSource, "onboarding"),
    join(absSource, "api"),
    join(absSource, "engineering"),
  ];

  for (const dir of dirs) {
    await mkdir(dir, { recursive: true }).catch(() => {});
  }

  const indexContent = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>Home</title></head>
<body>
<h1>Welcome</h1>
<p>Edit this file to get started with your documentation.</p>
</body>
</html>`;

  await writeFile(join(absSource, "index.html"), indexContent);
  console.log(`Created ${join(absSource, "index.html")}`);

  for (const dir of dirs) {
    console.log(`Created ${dir}/`);
  }
  console.log("\nRun: rendro push --source ./docs --organization <id> --project <id>");
}

function printHelp(): void {
  console.log(`rendro — deploy HTML documentation

Usage:
  rendro push --source <dir> --organization <id> --project <id> [--endpoint <url>] [--concurrency <n>] [--include-sensitive]
  rendro publication create --organization <id> --project <id> --slug <slug> [--path <prefix>] [--entry <file>] [--title <title>] [--pin <deployment-id>]
  rendro publication list --organization <id> --project <id> [--endpoint <url>]
  rendro publication remove --organization <id> --project <id> --id <publication-id>
  rendro init --source <dir>
  rendro --version

Options:
  --source       Path to local docs directory (default: ./docs)
  --organization Organization ID from Rendro
  --project      Project ID from Rendro
  --slug         Stable global public URL slug
  --path         Folder inside the deployment (default: deployment root)
  --entry        Public landing document inside the path (default: index.html)
  --pin          Pin to one deployment instead of tracking active
  --endpoint     Rendro server URL (default: https://rendro.app)
  --concurrency  Parallel uploads (default: 8)
  --include-sensitive  Include sensitive files (still honors .rendroignore)

Auth: set RENDRO_API_KEY in your environment. Create a scoped key from
      your organization's API keys page.
`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const cmd = args[0];

  if (cmd === "--version") {
    console.log(version);
    return;
  }

  if (!cmd || cmd === "help" || cmd === "--help") {
    printHelp();
    return;
  }

  const getFlag = (flag: string, fallback: string) => {
    const idx = args.indexOf(flag);
    return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : fallback;
  };

  if (cmd === "init") {
    await init(getFlag("--source", "./docs"));
    return;
  }

  if (cmd === "publication") {
    const action = args[1];
    const organizationId = getFlag("--organization", "");
    const projectId = getFlag("--project", "");
    const endpoint = getFlag("--endpoint", "https://rendro.app");
    const token = getFlag("--token", process.env.RENDRO_API_KEY || "");
    if (!organizationId || !projectId) {
      console.error("Error: --organization and --project are required");
      process.exit(1);
    }
    if (!token) {
      console.error("Error: RENDRO_API_KEY environment variable is required.");
      process.exit(1);
    }
    const base = { organizationId, projectId, endpoint, token };
    if (action === "list") {
      await listProjectPublications(base);
      return;
    }
    if (action === "remove") {
      const publicationId = getFlag("--id", "");
      if (!publicationId) {
        console.error("Error: --id is required for publication remove");
        process.exit(1);
      }
      await removePublication({ ...base, publicationId });
      return;
    }
    if (action === "create") {
      const slug = getFlag("--slug", "");
      if (!slug) {
        console.error("Error: --slug is required for publication create");
        process.exit(1);
      }
      const pinnedDeploymentId = getFlag("--pin", "") || undefined;
      await createPublication({
        ...base,
        slug,
        pathPrefix: getFlag("--path", ""),
        entryFile: getFlag("--entry", "index.html"),
        title: getFlag("--title", slug),
        trackingMode: pinnedDeploymentId ? "pinned" : "track_active",
        pinnedDeploymentId,
      });
      return;
    }
    console.error("Error: publication action must be create, list, or remove");
    process.exit(1);
  }

  if (cmd === "push") {
    const source = getFlag("--source", "./docs");
    const organizationId = getFlag("--organization", "");
    const projectId = getFlag("--project", "");
    const endpoint = getFlag("--endpoint", "https://rendro.app");
    const token = getFlag("--token", process.env.RENDRO_API_KEY || "");
    const concurrency = parseInt(getFlag("--concurrency", "8"), 10);

    if (!organizationId || !projectId) {
      console.error("Error: --organization and --project are required for push");
      process.exit(1);
    }
    if (!token) {
      console.error("Error: RENDRO_API_KEY environment variable is required. Get your key from the Rendro org page.");
      process.exit(1);
    }

    await push({ source, organizationId, projectId, endpoint, token, concurrency, includeSensitive: args.includes("--include-sensitive") });
    return;
  }

  console.error(`Unknown command: ${cmd}`);
  process.exit(1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
