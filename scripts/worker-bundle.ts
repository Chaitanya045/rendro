/**
 * The Workers' code weight (#357). Every new isolate parses and evaluates the whole bundle, so what the
 * serving Worker imports is cold-start time. This bundles each Worker's entry point with esbuild the way
 * Wrangler does (minified ESM, `cloudflare:` and Node built-ins left external), an approximation that tracks
 * Wrangler's output closely enough to catch growth, and reports its size and the packages inside it.
 * The serving Worker's size is recorded in scripts/bundle-budget.json beside the browser bundles; the
 * packages below may never appear in any Worker.
 */
import { resolve } from "node:path";
import { build } from "esbuild";

/** Budget key of the serving Worker's bundle. */
export const workerBudgetKey = "worker:src/worker.ts";

/** Every deployable Worker entry point (wrangler.toml, wrangler.control.toml, wrangler.ingest.toml). */
export const workerEntries = ["src/worker.ts", "src/repo-access/entry.ts", "src/ingest/orchestrator/entry.ts"] as const;

/** Packages no Worker bundles, with why. zod alone was about half of the serving Worker (every locale included). */
export const forbiddenPackages: Record<string, string> = {
  zod: "its schema builder and locales were about half of the serving Worker; validate with a small hand-written check instead (#357)",
};

export interface WorkerBundle {
  /** The minified bundle. */
  code: Uint8Array;
  /** Package names (scoped ones included) with code in the bundle, sorted. */
  packages: string[];
}

/** The package an input file belongs to, or null for the repository's own code. */
export function packageOf(input: string): string | null {
  const match = /(?:^|\/)node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?((?:@[^/]+\/)?[^/]+)/.exec(input);
  return match ? match[1]! : null;
}

export async function bundleWorker(root: string, entry: string): Promise<WorkerBundle> {
  const result = await build({
    absWorkingDir: root, entryPoints: [entry], bundle: true, minify: true, write: false, metafile: true, outfile: "worker.js",
    platform: "node", format: "esm", mainFields: ["module", "main"], conditions: ["workerd", "worker", "browser", "import"],
    external: ["cloudflare:*"], loader: { ".wasm": "empty" }, logLevel: "silent", tsconfig: resolve(root, "tsconfig.json"),
  });
  const packages = new Set<string>();
  for (const [input, details] of Object.entries(result.metafile.outputs["worker.js"]!.inputs)) {
    const name = packageOf(input);
    if (name && details.bytesInOutput > 0) packages.add(name);
  }
  return { code: result.outputFiles[0]!.contents, packages: [...packages].sort() };
}

/** One failure for each forbidden package a Worker bundles. */
export function forbiddenInBundle(entry: string, packages: string[]): string[] {
  return packages.filter((name) => name in forbiddenPackages)
    .map((name) => `${entry} bundles ${name}: ${forbiddenPackages[name]}.`);
}
