/**
 * Verifies that no R2 bucket Rendro binds can be read without going through the Worker: no managed
 * r2.dev URL and no custom domain. Worker routes are the only authorization boundary.
 *
 *   CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... pnpm check:r2-public [--bucket <name>]... [--dry-run]
 *
 * The token needs only read access to R2 on that account (Account > Workers R2 Storage > Read). Buckets
 * default to every `bucket_name` in wrangler.toml. `--dry-run` prints the requests it would make and
 * needs no credentials. Exit status: 0 private, 1 public access found or a bucket could not be checked,
 * 2 not configured.
 */
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

type Fetch = typeof fetch;
type Settings = { env: NodeJS.ProcessEnv; fetch: Fetch; log(line: string): void; wrangler: string };

const API = "https://api.cloudflare.com/client/v4";

/** Bucket names bound by wrangler.toml, in file order, without duplicates. */
export function wranglerBuckets(toml: string): string[] {
  const names = [...toml.replace(/#.*$/gm, "").matchAll(/^bucket_name\s*=\s*"([^"]+)"/gm)].map(match => match[1]!);
  return [...new Set(names)];
}

async function cloudflare(settings: Settings, path: string): Promise<unknown> {
  const response = await settings.fetch(`${API}${path}`, {
    headers: { Authorization: `Bearer ${settings.env.CLOUDFLARE_API_TOKEN}` },
    signal: AbortSignal.timeout(30_000),
  });
  const body = await response.json().catch(() => null) as { success?: boolean; result?: unknown } | null;
  if (!response.ok || body?.success !== true) throw new Error(`Cloudflare API answered ${response.status} for ${path}`);
  return body.result;
}

/** Why a bucket is publicly reachable, or an empty list if it is not. */
async function exposure(settings: Settings, account: string, bucket: string): Promise<string[]> {
  const base = `/accounts/${account}/r2/buckets/${encodeURIComponent(bucket)}/domains`;
  const problems: string[] = [];
  const managed = await cloudflare(settings, `${base}/managed`) as { enabled?: boolean; domain?: string } | null;
  // Anything but an explicit "disabled" counts: fail closed on an answer we do not understand.
  if (managed?.enabled !== false) problems.push(`r2.dev public URL is ${managed?.enabled === true ? "enabled" : "in an unknown state"}`);
  const custom = await cloudflare(settings, `${base}/custom`) as { domains?: Array<{ domain?: string; enabled?: boolean }> } | null;
  if (!Array.isArray(custom?.domains)) problems.push("custom domains are in an unknown state");
  for (const domain of custom?.domains ?? []) problems.push(`custom domain ${domain.domain ?? "(unnamed)"} is attached${domain.enabled === false ? " (disabled; remove it)" : ""}`);
  return problems;
}

export async function main(argv: string[], settings: Partial<Settings> = {}): Promise<number> {
  const resolved: Settings = { env: process.env, fetch, log: line => console.log(line), wrangler: "wrangler.toml", ...settings };
  const dryRun = argv.includes("--dry-run");
  const named = argv.flatMap((arg, index) => arg === "--bucket" && argv[index + 1] ? [argv[index + 1]!] : []);
  const buckets = named.length ? named : wranglerBuckets(await readFile(resolved.wrangler, "utf8"));
  if (!buckets.length) { resolved.log("No R2 bucket to check."); return 2; }

  const account = resolved.env.CLOUDFLARE_ACCOUNT_ID;
  if (dryRun) {
    for (const bucket of buckets) {
      for (const kind of ["managed", "custom"]) resolved.log(`GET ${API}/accounts/${account || "<CLOUDFLARE_ACCOUNT_ID>"}/r2/buckets/${bucket}/domains/${kind}`);
    }
    resolved.log("Dry run: no request was made.");
    return 0;
  }
  if (!account || !resolved.env.CLOUDFLARE_API_TOKEN) {
    resolved.log("CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN (read access to R2) are required; the bucket was NOT verified.");
    return 2;
  }

  let status = 0;
  for (const bucket of buckets) {
    try {
      const problems = await exposure(resolved, account, bucket);
      if (problems.length) status = 1;
      resolved.log(problems.length ? `FAIL ${bucket}: ${problems.join("; ")}` : `ok   ${bucket}: no r2.dev URL and no custom domain`);
    } catch (error) {
      status = 1;
      resolved.log(`FAIL ${bucket}: could not be verified (${error instanceof Error ? error.message : "unknown error"})`);
    }
  }
  return status;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }, (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
