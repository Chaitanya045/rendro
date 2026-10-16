import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { glob } from "tinyglobby";
import { runGate } from "../../scripts/coverage-gate";
import { normalizeNodeCoverage } from "./normalize-node-coverage";

export function browserCoverageShards(directory: string, suites: string[]) {
  const receipts = readdirSync(directory).filter(name => name.endsWith(".json"));
  for (const suite of suites) {
    if (!receipts.some(name => name.startsWith(`${basename(suite)}-`))) throw new Error(`Missing browser coverage: ${suite}`);
  }
  const shards = receipts.map(name => resolve(directory, name)).filter(path => Object.keys(JSON.parse(readFileSync(path, "utf8")) as object).length);
  if (!shards.length) throw new Error("No browser source coverage collected");
  return shards;
}

async function main() {
  // Vitest cleans coverage/ before running. Each context writes even an empty
  // receipt, so a missing suite is an error instead of an optional wildcard.
  const directory = resolve("coverage/browser");
  const args = process.argv.slice(2);
  if (!args.includes("--merge-only")) {
    const run = spawnSync("pnpm", ["exec", "vitest", "run", "--coverage"], {
      stdio: "inherit", env: { ...process.env, RENDRO_BROWSER_COVERAGE_DIR: directory },
    });
    if (run.status !== 0) process.exit(run.status ?? 1);
  }
  const shards = browserCoverageShards(directory, await glob("tests/*-browser.test.ts"));
  const node = await normalizeNodeCoverage(process.cwd(), "coverage/coverage-final.json", shards);
  await runGate(process.cwd(), [node, ...shards, ...args.filter(arg => arg !== "--merge-only")], process.env.COVERAGE_DEBT_BASE);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
