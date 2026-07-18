#!/usr/bin/env node
/**
 * rendro CLI — push docs from a local directory to the rendro server.
 *
 * Usage:
 *   rendro push --source ./docs --org acme-corp --repo backend --endpoint http://localhost:3000 --token dev-sync-token
 *   rendro init  --source ./docs   # scaffolds a default docs dir
 */

import { createHash } from "node:crypto";
import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { join, resolve, relative } from "node:path";

interface PushOptions {
  source: string;
  org: string;
  endpoint: string;
  token: string;
  repo?: string;
  concurrency?: number;
}

interface FileEntry {
  path: string;      // local absolute path
  key: string;       // R2/MinIO key: org[/repo]/relative/path.html
  hash: string;      // SHA-256 hex
}

function md5(content: string | Uint8Array): string {
  return createHash("md5").update(content).digest("hex");
}

const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

async function walk(dir: string, baseDir: string): Promise<string[]> {
  const files: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      // Skip hidden dirs and node_modules
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      files.push(...(await walk(full, baseDir)));
    } else if (entry.isFile() && entry.name.endsWith(".html")) {
      files.push(full);
    }
  }

  return files;
}

async function push(opts: PushOptions): Promise<void> {
  const { source, org, repo, endpoint, token, concurrency = 8 } = opts;

  // Resolve absolute paths
  const absSource = resolve(source);
  const htmlFiles = await walk(absSource, absSource);
  const keyPrefix = repo ? `${org}/${repo}/` : `${org}/`;

  if (htmlFiles.length === 0) {
    console.log(`No .html files found in ${source}`);
    return;
  }

  console.log(`Found ${htmlFiles.length} HTML files in ${source}\n`);

  // Build file entries with hashes
  const entries: FileEntry[] = [];
  for (const file of htmlFiles) {
    const rel = relative(absSource, file).replace(/\\/g, "/");
    const key = `${keyPrefix}${rel}`;
    const content = await readFile(file);
    const hash = md5(content);
    entries.push({ path: file, key, hash });
  }

  // Check which files need uploading by calling the server's check endpoint
  const toUpload: FileEntry[] = [];
  let skipped = 0;

  const checkBatch = async (batch: FileEntry[]) => {
    const results = await Promise.all(
      batch.map(async (entry) => {
        const url = `${endpoint}/api/sync/check?key=${encodeURIComponent(entry.key)}&hash=${entry.hash}`;
        try {
          const res = await fetch(url, {
            headers: { Authorization: `Bearer ${token}` },
          });
          if (!res.ok) return { entry, needsUpload: true };
          const body = (await res.json()) as { exists: boolean; match: boolean };
          return { entry, needsUpload: !body.match };
        } catch {
          return { entry, needsUpload: true };
        }
      })
    );

    for (const r of results) {
      if (r.needsUpload) {
        toUpload.push(r.entry);
      } else {
        skipped++;
        console.log(`  ✓ ${r.entry.key} (unchanged)`);
      }
    }
  };

  // Process in batches
  for (let i = 0; i < entries.length; i += concurrency) {
    await checkBatch(entries.slice(i, i + concurrency));
  }

  console.log(`\n${toUpload.length} files to upload, ${skipped} skipped\n`);

  // Upload changed files with controlled concurrency
  const upload = async (entry: FileEntry) => {
    const content = await readFile(entry.path);
    const res = await fetch(`${endpoint}/api/sync/upload`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        key: entry.key,
        content: content.toString("utf-8"),
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Upload failed for ${entry.key}: ${res.status} ${text}`);
    }

    console.log(`  ↑ ${entry.key}`);
  };

  let uploaded = 0;
  for (let i = 0; i < toUpload.length; i += concurrency) {
    const batch = toUpload.slice(i, i + concurrency);
    await Promise.all(batch.map(upload));
    uploaded += batch.length;
  }
  console.log(`\nDone. ${uploaded} uploaded, ${skipped} skipped, ${htmlFiles.length} total.`);

  // Sync deletes — remove files from server that don't exist locally
  const localKeys = new Set(entries.map((e) => e.key));
  try {
    const listUrl = new URL("/api/sync/list", endpoint);
    if (repo) listUrl.searchParams.set("prefix", keyPrefix);
    const listRes = await fetch(listUrl, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const { keys: serverKeys } = (await listRes.json()) as { keys: string[] };
    let deleted = 0;
    for (const key of serverKeys) {
      if (!localKeys.has(key)) {
        await fetch(`${endpoint}/api/sync/delete?key=${encodeURIComponent(key)}`, {
          method: "DELETE",
          headers: { Authorization: `Bearer ${token}` },
        });
        console.log(`  ↓ ${key} (soft-deleted)`);
        deleted++;
      }
    }
    console.log(`${deleted} files soft-deleted, ${uploaded} uploaded, ${skipped} skipped, ${htmlFiles.length} total.`);
  } catch (e) {
    console.error("Sync-deletes failed:", e);
  }
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
  console.log("\nRun: rendro push --source ./docs --org <your-org>");
}

// CLI entry
async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];

  if (!cmd || cmd === "help" || cmd === "--help") {
    console.log(`rendro — sync HTML docs to Rendro
    console.log(\`rendro — sync HTML docs to Rendro

Usage:
  rendro push  --source <dir> --org <slug> [--repo <slug>] [--endpoint <url>] [--concurrency <n>]
  rendro init  --source <dir>

Options:
  --source       Path to local docs directory (default: ./docs)
  --org          Organization slug (required for push)
  --repo         Optional repository slug. Scopes keys and deletes to <org>/<repo>/
  --endpoint     Rendro server URL (default: http://localhost:3000)
  --concurrency  Parallel uploads (default: 8)

Auth: set RENDRO_API_KEY in your environment. Get your key from
      the Rendro org page after creating your organization.
\`);
`);
    return;
  }

  if (cmd === "init") {
    const source = args.includes("--source")
      ? args[args.indexOf("--source") + 1]
      : "./docs";
    await init(source);
    return;
  }

  if (cmd === "push") {
    const getFlag = (flag: string, fallback: string) => {
      const idx = args.indexOf(flag);
      return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : fallback;
    };

    const source = getFlag("--source", "./docs");
    const org = getFlag("--org", "");
    const repo = getFlag("--repo", "");
    const endpoint = getFlag("--endpoint", "http://localhost:3000");
    const token = getFlag("--token", process.env.RENDRO_API_KEY || "");
    const concurrency = parseInt(getFlag("--concurrency", "8"), 10);

    if (!org) {
      console.error("Error: --org is required for push");
      process.exit(1);
    }
    if (repo && !slugPattern.test(repo)) {
      console.error("Error: --repo must be a lowercase slug, e.g. backend or api-docs");
      process.exit(1);
    }
    if (!token) {
      console.error("Error: RENDRO_API_KEY environment variable is required. Get your key from the Rendro org page.");
      process.exit(1);
    }
    await push({ source, org, repo: repo || undefined, endpoint, token, concurrency });
    return;
  }

  console.error(`Unknown command: ${cmd}`);
  process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
