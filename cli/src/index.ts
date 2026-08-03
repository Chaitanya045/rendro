#!/usr/bin/env node
/**
 * rendro CLI — sync and publish HTML documentation.
 *
 * Usage:
 *   rendro push --source ./docs --org acme-corp --repo api --endpoint https://rendro.app
 *   rendro publish --org acme-corp --repo api --folder product --slug product
 *   rendro publications --org acme-corp
 *   rendro unpublish --org acme-corp --slug product
 *   rendro init --source ./docs
 */
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

interface PushOptions {
  source: string;
  org: string;
  repo: string;
  endpoint: string;
  token: string;
  concurrency?: number;
}

interface PublicationApiOptions {
  org: string;
  endpoint: string;
  token: string;
}

interface PublicationResponse {
  orgSlug: string;
  slug: string;
  sourcePrefix: string;
  title: string;
  entryFile: string;
  url: string;
  documentCount?: number;
}

interface FileEntry {
  path: string;
  rel: string;
  key: string;
  hash: string;
}

function md5(content: string | Uint8Array): string {
  return createHash("md5").update(content).digest("hex");
}

async function walk(dir: string, baseDir: string): Promise<string[]> {
  const files: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      files.push(...await walk(full, baseDir));
    } else if (entry.isFile() && entry.name.endsWith(".html")) {
      files.push(full);
    }
  }

  return files;
}

async function requestJson<T>(url: string, token: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  headers.set("Authorization", `Bearer ${token}`);
  const res = await fetch(url, { ...init, headers });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return await res.json() as T;
}

async function fetchJson<T>(url: string, token: string): Promise<T> {
  return requestJson<T>(url, token);
}

async function push(opts: PushOptions): Promise<void> {
  const { source, org, repo, endpoint, token, concurrency = 8 } = opts;
  const cleanEndpoint = endpoint.replace(/\/$/, "");
  const absSource = resolve(source);
  const prefix = repo ? `${org}/${repo}/` : `${org}/`;
  const targetLabel = repo ? `(org: ${org}, repo: ${repo})` : `(org: ${org})`;

  console.log(`→ Syncing ${source} to ${cleanEndpoint} ${targetLabel}`);

  try {
    await fetchJson<{ keys: string[] }>(`${cleanEndpoint}/api/sync/list?prefix=${encodeURIComponent(prefix)}`, token);
  } catch {
    throw new Error("API key invalid or prefix unauthorized");
  }

  console.log("✓ API key valid");

  const htmlFiles = await walk(absSource, absSource);
  const entries: FileEntry[] = [];

  for (const file of htmlFiles) {
    const rel = relative(absSource, file);
    const key = `${prefix}${rel}`;
    const content = await readFile(file);
    entries.push({ path: file, rel, key, hash: md5(content) });
  }

  const toUpload: FileEntry[] = [];
  let skipped = 0;

  const checkBatch = async (batch: FileEntry[]) => {
    const results = await Promise.all(batch.map(async (entry) => {
      const url = `${cleanEndpoint}/api/sync/check?key=${encodeURIComponent(entry.key)}&hash=${entry.hash}`;
      try {
        const body = await fetchJson<{ exists: boolean; match: boolean }>(url, token);
        return { entry, needsUpload: !body.match };
      } catch {
        return { entry, needsUpload: true };
      }
    }));

    for (const result of results) {
      if (result.needsUpload) {
        toUpload.push(result.entry);
      } else {
        skipped++;
      }
    }
  };

  for (let i = 0; i < entries.length; i += concurrency) {
    await checkBatch(entries.slice(i, i + concurrency));
  }

  const upload = async (entry: FileEntry) => {
    const content = await readFile(entry.path, "utf8");
    const res = await fetch(`${cleanEndpoint}/api/sync/upload`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ key: entry.key, content }),
    });

    if (!res.ok) {
      throw new Error(`Upload failed for ${entry.rel}: ${res.status} ${await res.text()}`);
    }

    console.log(`  ↑ ${entry.rel}`);
  };

  let uploaded = 0;
  for (let i = 0; i < toUpload.length; i += concurrency) {
    const batch = toUpload.slice(i, i + concurrency);
    await Promise.all(batch.map(upload));
    uploaded += batch.length;
  }

  const existing = await fetchJson<{ keys: string[] }>(`${cleanEndpoint}/api/sync/list?prefix=${encodeURIComponent(prefix)}`, token);
  const localKeys = new Set(entries.map((entry) => entry.key));
  let deleted = 0;

  for (const serverKey of existing.keys.filter((key) => key.startsWith(prefix))) {
    if (localKeys.has(serverKey)) continue;
    const rel = serverKey.startsWith(prefix) ? serverKey.slice(prefix.length) : serverKey;
    const res = await fetch(`${cleanEndpoint}/api/sync/delete?key=${encodeURIComponent(serverKey)}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`Delete failed for ${rel}: ${res.status} ${await res.text()}`);
    console.log(`  ✗ ${rel} (deleted)`);
    deleted++;
  }

  console.log("");
  console.log(`✓ Sync complete: ${uploaded} uploaded, ${skipped} unchanged, ${deleted} deleted`);
}

function publicSourcePrefix(org: string, repo: string, folder: string): string {
  const trimmedFolder = folder.trim().replace(/^\/+|\/+$/g, "");
  const folderParts = trimmedFolder === "." ? [] : trimmedFolder.split("/");
  const parts = [org, ...(repo ? [repo] : []), ...folderParts];
  if (
    !org ||
    folder.includes("\\") ||
    folderParts.some((part) => !part || part === "." || part === "..") ||
    parts.some((part) => part.includes("\0"))
  ) {
    throw new Error("Folder must be a relative path inside the pushed docs tree");
  }
  return `${parts.join("/")}/`;
}

async function publishFolder(
  opts: PublicationApiOptions & {
    repo: string;
    folder: string;
    slug: string;
    title: string;
    entryFile: string;
  },
): Promise<void> {
  const endpoint = opts.endpoint.replace(/\/$/, "");
  const sourcePrefix = publicSourcePrefix(opts.org, opts.repo, opts.folder);
  const publication = await requestJson<PublicationResponse>(
    `${endpoint}/api/publications`,
    opts.token,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sourcePrefix,
        slug: opts.slug,
        title: opts.title,
        entryFile: opts.entryFile,
      }),
    },
  );
  console.log(`✓ Published ${publication.documentCount ?? 0} documents`);
  console.log(publication.url);
}

async function showPublications(opts: PublicationApiOptions): Promise<void> {
  const endpoint = opts.endpoint.replace(/\/$/, "");
  const result = await requestJson<{ publications: PublicationResponse[] }>(
    `${endpoint}/api/publications`,
    opts.token,
  );
  if (result.publications.length === 0) {
    console.log("No public folders");
    return;
  }
  for (const publication of result.publications) {
    console.log(`${publication.slug}  ${publication.url}`);
    console.log(`  ${publication.sourcePrefix} → ${publication.entryFile}`);
  }
}

async function unpublishFolder(
  opts: PublicationApiOptions & { slug: string },
): Promise<void> {
  const endpoint = opts.endpoint.replace(/\/$/, "");
  await requestJson<{ unpublished: boolean }>(
    `${endpoint}/api/publications/${encodeURIComponent(opts.slug)}`,
    opts.token,
    { method: "DELETE" },
  );
  console.log(`✓ Unpublished ${opts.slug}`);
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
  console.log("\nRun: rendro push --source ./docs --org <your-org> --repo <repo-name>");
}

function printHelp(): void {
  console.log(`rendro — sync HTML docs to Rendro

Usage:
  rendro push --source <dir> --org <slug> [--repo <name>] [--endpoint <url>] [--concurrency <n>]
  rendro publish --org <slug> [--repo <name>] --folder <path> --slug <slug> [--entry <file>] [--title <title>]
  rendro publications --org <slug> [--endpoint <url>]
  rendro unpublish --org <slug> --slug <slug> [--endpoint <url>]
  rendro init --source <dir>

Options:
  --source       Path to local docs directory (default: ./docs)
  --org          Organization slug
  --repo         Optional repo slug; docs sync under <org>/<repo>/
  --folder       Folder relative to the pushed docs root
  --slug         Stable public URL slug
  --entry        Public landing document inside the folder (default: index.html)
  --title        Public documentation title (default: slug)
  --endpoint     Rendro server URL (default: https://rendro.app)
  --concurrency  Parallel uploads (default: 8)

Auth: set RENDRO_API_KEY in your environment. Get your key from
      the Rendro org page after creating your organization.
`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const cmd = args[0];

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

  if (cmd === "publish" || cmd === "publications" || cmd === "unpublish") {
    const org = getFlag("--org", "");
    const endpoint = getFlag("--endpoint", "https://rendro.app");
    const token = getFlag("--token", process.env.RENDRO_API_KEY || "");
    if (!org) {
      console.error(`Error: --org is required for ${cmd}`);
      process.exit(1);
    }
    if (!token) {
      console.error("Error: RENDRO_API_KEY environment variable is required. Get your key from the Rendro org page.");
      process.exit(1);
    }

    if (cmd === "publications") {
      await showPublications({ org, endpoint, token });
      return;
    }

    const slug = getFlag("--slug", "");
    if (!slug) {
      console.error(`Error: --slug is required for ${cmd}`);
      process.exit(1);
    }
    if (cmd === "unpublish") {
      await unpublishFolder({ org, endpoint, token, slug });
      return;
    }

    const folder = getFlag("--folder", "");
    if (!folder) {
      console.error("Error: --folder is required for publish");
      process.exit(1);
    }
    await publishFolder({
      org,
      endpoint,
      token,
      slug,
      folder,
      repo: getFlag("--repo", ""),
      entryFile: getFlag("--entry", "index.html"),
      title: getFlag("--title", slug),
    });
    return;
  }

  if (cmd === "push") {
    const source = getFlag("--source", "./docs");
    const org = getFlag("--org", "");
    const repo = getFlag("--repo", "");
    const endpoint = getFlag("--endpoint", "https://rendro.app");
    const token = getFlag("--token", process.env.RENDRO_API_KEY || "");
    const concurrency = parseInt(getFlag("--concurrency", "8"), 10);

    if (!org) {
      console.error("Error: --org is required for push");
      process.exit(1);
    }
    if (!token) {
      console.error("Error: RENDRO_API_KEY environment variable is required. Get your key from the Rendro org page.");
      process.exit(1);
    }

    await push({ source, org, repo, endpoint, token, concurrency });
    return;
  }

  console.error(`Unknown command: ${cmd}`);
  process.exit(1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
