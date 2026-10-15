import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import convert from "ast-v8-to-istanbul";
import { transform } from "esbuild";
import libCoverage from "istanbul-lib-coverage";
import type { CoverageSummaryData, FileCoverageData } from "istanbul-lib-coverage";
import { glob } from "tinyglobby";
import { z } from "zod";
import { sourceExclude, sourceInclude } from "./coverage-policy";

export const metrics = ["statements", "branches", "functions", "lines"] as const;
const count = z.number().int().nonnegative();
const debtSchema = z.object({ statements: count, branches: count, functions: count, lines: count }).strict();
const ledgerSchema = z.object({ version: z.literal(1), files: z.record(z.string(), debtSchema) }).strict();
export type Ledger = z.infer<typeof ledgerSchema>;
const position = z.object({ line: z.number().int().positive(), column: count });
// Istanbul JSON serializes remapped end-of-line Infinity columns as null.
const location = z.object({ start: position, end: position.extend({ column: count.nullable() }) });
// An implicit else arm can have no source span; its counter still matters.
const branchLocation = z.union([location, z.object({ start: z.object({}).strict(), end: z.object({}).strict() })]);
const fileSchema = z.object({
  path: z.string().min(1),
  statementMap: z.record(z.string(), location),
  fnMap: z.record(z.string(), z.object({ name: z.string(), decl: location, loc: location, line: count })),
  branchMap: z.record(z.string(), z.object({ type: z.string(), loc: location, locations: z.array(branchLocation), line: count })),
  s: z.record(z.string(), count), f: z.record(z.string(), count),
  // V8 remapping can infer negative implicit-else hits. Istanbul treats these
  // as uncovered; clamp before addition so they cannot cancel another shard.
  b: z.record(z.string(), z.array(z.number().int().transform(hits => Math.max(0, hits)))),
});
const readJson = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"));

export function canonicalPath(root: string, source: string) {
  const path = source.startsWith("file:") ? fileURLToPath(source) : source.replaceAll("\\", "/");
  const name = relative(root, resolve(root, path)).replaceAll("\\", "/");
  if (!name || name === ".." || name.startsWith("../") || /^[A-Za-z]:/.test(name)) throw new Error(`Source outside repository: ${source}`);
  return name;
}

// Normalize counter IDs by source location. Reject incompatible maps instead of
// letting Istanbul's range heuristics silently combine different transforms.
function normalizeFile(input: unknown): FileCoverageData {
  const data = fileSchema.parse(input);
  for (const [counter, map] of [["s", "statementMap"], ["f", "fnMap"], ["b", "branchMap"]] as const) {
    const ids = Object.keys(data[map]);
    if (JSON.stringify(ids.sort()) !== JSON.stringify(Object.keys(data[counter]).sort())) throw new Error(`Counter/map mismatch: ${data.path}`);
    const ordered = ids.sort((a, b) => JSON.stringify(data[map][a]).localeCompare(JSON.stringify(data[map][b])));
    const maps = ordered.map((id, i) => [String(i), data[map][id]]);
    const counters = ordered.map((id, i) => [String(i), data[counter][id]]);
    Object.assign(data, { [map]: Object.fromEntries(maps), [counter]: Object.fromEntries(counters) });
  }
  for (const id of Object.keys(data.b)) {
    if (data.b[id].length !== data.branchMap[id].locations.length) throw new Error(`Branch/map mismatch: ${data.path}`);
  }
  // Istanbul's published types omit these valid serialized location forms.
  return data as unknown as FileCoverageData;
}

export async function sourceManifest(root: string) {
  const files = await glob(sourceInclude, { cwd: root, ignore: sourceExclude, dot: true, followSymbolicLinks: false, expandDirectories: false });
  if (!files.length) throw new Error("Empty source manifest");
  return files.sort();
}

async function zeroCoverage(root: string, name: string) {
  const path = resolve(root, name);
  const output = await transform(readFileSync(path, "utf8"), {
    loader: name.endsWith(".ts") ? "ts" : "js", sourcefile: path, sourcemap: "external", target: "esnext",
  });
  const { parseAstAsync } = await import("vitest/node");
  const converted = await convert({
    code: output.code, sourceMap: JSON.parse(output.map), ast: parseAstAsync(output.code),
    coverage: { url: pathToFileURL(path).href, functions: [] },
  });
  const map = libCoverage.createCoverageMap(converted);
  // A type-only/empty module has no mapped executable nodes. Keep its manifest entry.
  const coverage = map.files().length ? map.fileCoverageFor(path) : libCoverage.createFileCoverage(path);
  coverage.resetHits();
  return { ...coverage.data, path: name };
}

export async function mergeReports(root: string, shards: string[]) {
  if (!shards.length) throw new Error("Provide at least one Istanbul JSON shard");
  const manifest = await sourceManifest(root);
  const included = new Set(manifest);
  const merged = libCoverage.createCoverageMap({});
  for (const shard of shards) {
    const report = z.record(z.string(), z.unknown()).parse(readJson(resolve(root, shard)));
    let accepted = 0;
    for (const [key, input] of Object.entries(report)) {
      const name = canonicalPath(root, key);
      if (!included.has(name)) continue;
      const file = normalizeFile(input);
      if (canonicalPath(root, file.path) !== name) throw new Error(`Coverage key/path mismatch: ${key}`);
      file.path = name;
      if (merged.files().includes(name)) {
        const previous = merged.fileCoverageFor(name);
        for (const map of ["statementMap", "fnMap", "branchMap"] as const) {
          if (JSON.stringify(previous[map]) !== JSON.stringify(file[map])) throw new Error(`Incompatible coverage maps: ${name}`);
        }
        // Maps are identical after normalization. Add by normalized ID so
        // branches sharing a first location cannot collapse in Istanbul's merge.
        for (const counter of ["s", "f"] as const) {
          for (const id of Object.keys(file[counter])) previous[counter][id] += file[counter][id];
        }
        for (const id of Object.keys(file.b)) previous.b[id] = previous.b[id].map((hits, index) => hits + file.b[id][index]);
      } else {
        merged.addFileCoverage(file);
      }
      accepted++;
    }
    if (!accepted) throw new Error(`Empty coverage shard (no authored sources): ${shard}`);
  }
  const missing = manifest.filter(name => !merged.files().includes(name));
  for (const name of missing) merged.addFileCoverage(await zeroCoverage(root, name));
  const total = merged.getCoverageSummary().toJSON();
  const files = Object.fromEntries(manifest.map(name => [name, merged.fileCoverageFor(name).toSummary().toJSON()]));
  const debt = Object.fromEntries(manifest.map(name => [name, Object.fromEntries(metrics.map(metric => [metric, files[name][metric].total - files[name][metric].covered]))])) as Ledger["files"];
  return { merged, summary: { total, ...files } as Record<string, CoverageSummaryData>, debt, missing };
}

export function checkLedger(debt: Ledger["files"], ledger: Ledger, update: boolean) {
  const errors: string[] = [];
  const files: Ledger["files"] = {};
  for (const [name, uncovered] of Object.entries(debt)) {
    for (const metric of metrics) {
      const allowed = ledger.files[name]?.[metric] ?? 0;
      if (uncovered[metric] > allowed) errors.push(`${name}: uncovered ${metric} ${uncovered[metric]} > ${allowed}; debt cannot increase`);
    }
    if (metrics.some(metric => uncovered[metric] > 0)) files[name] = uncovered;
  }
  for (const name of Object.keys(ledger.files)) {
    if (!files[name] && !update) errors.push(`${name}: delete stale entry from coverage-debt.json (100% covered or removed source)`);
  }
  return { errors, next: { version: 1, files } satisfies Ledger };
}

// CI also rejects hand-edited increases relative to the PR base. The initial
// rollout has no ledger at the base; every subsequent revision is shrink-only.
export function checkLedgerHistory(root: string, ledger: Ledger, base: string) {
  if (/^0+$/.test(base)) return;
  const name = "coverage-debt.json";
  const exists = execFileSync("git", ["ls-tree", "--name-only", base, "--", name], { cwd: root, encoding: "utf8" }).trim();
  if (!exists) return;
  const previous = ledgerSchema.parse(JSON.parse(execFileSync("git", ["show", `${base}:${name}`], { cwd: root, encoding: "utf8" })));
  const { errors } = checkLedger(ledger.files, previous, true);
  for (const name of Object.keys(ledger.files)) {
    if (!Object.hasOwn(previous.files, name)) errors.push(`${name}: new ledger entries are forbidden`);
  }
  if (errors.length) throw new Error(errors.join("\n"));
}

export async function runGate(root: string, args: string[], base = "") {
  const update = args.includes("--update-ledger");
  const shards = args.filter(arg => arg !== "--update-ledger");
  if (shards.some(arg => arg.startsWith("--"))) throw new Error("Unknown coverage gate option");
  const result = await mergeReports(root, shards);
  const output = resolve(root, "coverage/merged");
  mkdirSync(output, { recursive: true });
  writeFileSync(`${output}/coverage-summary.json`, JSON.stringify(result.summary, null, 2) + "\n");
  writeFileSync(`${output}/coverage-final.json`, JSON.stringify(result.merged) + "\n");
  for (const metric of metrics) {
    const { covered, total } = result.summary.total[metric];
    console.log(`${metric}: ${covered}/${total} (${total ? (100 * covered / total).toFixed(2) + "%" : "N/A"})`);
  }
  const ledgerPath = resolve(root, "coverage-debt.json");
  const ledger = ledgerSchema.parse(readJson(ledgerPath));
  if (base) checkLedgerHistory(root, ledger, base);
  const { errors, next } = checkLedger(result.debt, ledger, update);
  for (const name of result.missing) errors.push(`${name}: missing from every shard; seeded with zero coverage`);
  if (errors.length) throw new Error(errors.join("\n"));
  if (update) writeFileSync(ledgerPath, JSON.stringify(next, null, 2) + "\n");
  console.log(`Coverage gate passed (${Object.keys(result.debt).length} source files).`);
}

export async function main() {
  try {
    await runGate(process.cwd(), process.argv.slice(2), process.env.COVERAGE_DEBT_BASE);
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
