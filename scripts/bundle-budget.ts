import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { brotliCompressSync, constants } from "node:zlib";
import { versionedBundles } from "../src/routes/versioned-bundles";

export const budgetPath = "scripts/bundle-budget.json";
/** Growth up to this fraction of the recorded size passes (toolchain noise); anything more must be recorded. */
export const tolerance = 0.01;
const wasm = "src/ingest/comrak-engine/comrak_engine_bg.wasm";
/** Content-hashed directories: the key drops the hash so it survives a rebuild. */
const hashedDirectories = [["public/styles", ".css"], ["public/fonts", ".woff2"]] as const;

/** Bytes as built (`raw`) and as the edge serves them (`brotli`, quality 11). */
export interface BundleSize { raw: number; brotli: number }
/** Budget key (path, without a content hash) → recorded size. */
export type BundleBudget = Record<string, BundleSize>;

/** Every served bundle: budget key → file, relative to the repository root. */
export function servedBundles(root: string): Map<string, string> {
  const bundles = new Map<string, string>();
  for (const route of Object.keys(versionedBundles)) bundles.set(`public${route}`, `public${route}`);
  for (const [directory, extension] of hashedDirectories) {
    for (const name of readdirSync(join(root, directory)).sort()) {
      if (name.endsWith(extension)) bundles.set(`${directory}/${name.replace(/\.[0-9a-f]{10}(?=\.[^.]+$)/, "")}`, `${directory}/${name}`);
    }
  }
  bundles.set(wasm, wasm);
  return bundles;
}

export function measure(data: Uint8Array): BundleSize {
  const brotli = brotliCompressSync(data, { params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: data.length } });
  return { raw: data.length, brotli: brotli.length };
}

const metrics = [["brotli", "Brotli"], ["raw", "raw"]] as const;
const bytes = (value: number) => `${value.toLocaleString("en-US")} B`;

export interface BudgetReport {
  /** Each one fails the check. */
  failures: string[];
  /** Shrunk bundles whose budget could be lowered. */
  hints: string[];
}

/** Compares measured sizes with the recorded budget. Shrinking always passes. */
export function checkBudget(budget: BundleBudget, sizes: BundleBudget): BudgetReport {
  const failures: string[] = [];
  const hints: string[] = [];
  for (const [name, size] of Object.entries(sizes)) {
    const recorded = budget[name];
    if (!recorded) {
      failures.push(`${name} has no budget entry (${bytes(size.brotli)} Brotli, ${bytes(size.raw)} raw). Run pnpm record:budget to add it.`);
      continue;
    }
    for (const [metric, label] of metrics) {
      const delta = size[metric] - recorded[metric];
      const sign = delta > 0 ? "+" : "−";
      const change = `${label} ${bytes(recorded[metric])} → ${bytes(size[metric])} (${sign}${bytes(Math.abs(delta))}, ${sign}${(Math.abs(delta) / recorded[metric] * 100).toFixed(1)}%)`;
      if (size[metric] > Math.floor(recorded[metric] * (1 + tolerance))) {
        failures.push(`${name} grew beyond its budget: ${change}. If the weight is intended, run pnpm record:budget and commit ${budgetPath} with the change so it is reviewed.`);
      } else if (delta < 0) {
        hints.push(`${name} shrank: ${change}. Run pnpm record:budget to lower its budget.`);
      }
    }
  }
  for (const name of Object.keys(budget)) {
    if (!sizes[name]) failures.push(`${name} has a budget but is no longer served. Run pnpm record:budget to drop its entry.`);
  }
  return { failures, hints };
}

/** CLI behaviour: check the built bundles against the budget, or with --record rewrite it. */
export function runBundleBudget(root: string, args: string[], log: (message: string) => void = console.log): number {
  const sizes: BundleBudget = {};
  const missing: string[] = [];
  for (const [name, file] of servedBundles(root)) {
    const path = join(root, file);
    if (existsSync(path)) sizes[name] = measure(readFileSync(path));
    else missing.push(`${file} is missing. Run pnpm build:assets first.`);
  }
  if (missing.length) {
    log(missing.join("\n"));
    return 1;
  }
  const file = join(root, budgetPath);
  if (args.includes("--record")) {
    const sorted = Object.fromEntries(Object.entries(sizes).sort(([a], [b]) => a.localeCompare(b)));
    writeFileSync(file, JSON.stringify(sorted, null, 2) + "\n");
    log(`Recorded the budget of ${Object.keys(sizes).length} bundles in ${budgetPath}.`);
    return 0;
  }
  const budget = (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {}) as BundleBudget;
  const { failures, hints } = checkBudget(budget, sizes);
  if (failures.length) {
    log([...failures, ...hints].join("\n"));
    return 1;
  }
  log([...hints, `Bundle budget verified (${Object.keys(sizes).length} bundles, ${tolerance * 100}% tolerance).`].join("\n"));
  return 0;
}
