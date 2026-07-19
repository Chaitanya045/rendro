#!/usr/bin/env node
/**
 * rendro CLI — push docs from a local directory to the Rendro server.
 *
 * Usage:
 *   rendro push --source ./docs --org acme-corp --repo api --endpoint https://rendro.app
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

async function fetchJson<T>(url: string, token: string): Promise<T> {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return await res.json() as T;
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
  rendro init --source <dir>

Options:
  --source       Path to local docs directory (default: ./docs)
  --org          Organization slug (required for push)
  --repo         Optional repo slug; when set, docs sync under <org>/<repo>/
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
