import { mergeScriptCovs } from "@bcoe/v8-coverage";
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import type { Profiler } from "node:inspector";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import convert from "ast-v8-to-istanbul";
import { transform } from "esbuild";
import type { CoverageMapData, FileCoverageData } from "istanbul-lib-coverage";
import { parseAstAsync } from "vitest/node";
import { canonicalPath, sourceManifest } from "../../scripts/coverage-gate";
import { convertMapped, mergeBrowserFile, type MappedSource } from "./browser-coverage";
import { alignCoverage, canonicalCoverage, reprintedIdentities } from "./normalize-node-coverage";
import { subprocessBundleRegistry, subprocessRawDirectory } from "./subprocess-coverage";

/** The part of Node's NODE_V8_COVERAGE dump this merger reads. */
export interface NodeDump {
  result: Profiler.ScriptCoverage[];
  "source-map-cache"?: Record<string, { lineLengths: number[]; data: MappedSource | null } | undefined>;
}

type Mapped = { lineLengths: number[]; data: MappedSource };


/** End offsets of dynamic `import(...)` expressions, which tsx follows with a `.then(...)` interop callback. */
async function dynamicImportEnds(code: string) {
  const ends: number[] = [];
  const visit = (node: unknown) => {
    if (Array.isArray(node)) { node.forEach(visit); return; }
    if (!node || typeof node !== "object") return;
    const { type, end } = node as { type?: string; end?: number };
    if (type === "ImportExpression") ends.push(end!);
    for (const value of Object.values(node)) visit(value);
  };
  visit(await parseAstAsync(code));
  return ends.sort((a, b) => a - b);
}

/**
 * tsx compiles TypeScript on load and V8 reports offsets of ITS output, which no
 * dump retains (only the source map and line lengths). Reproduce the transform with
 * tsx's coverage-mode options and accept it only if every line length equals what
 * the child recorded (tsx re-encodes the source map, so its text may differ). tsx's
 * dynamic-import interop callback is inserted as a same-length placeholder, since
 * it is unmapped and only its length moves later offsets. Anything else is an error.
 */
export async function reproduceTsxModule(source: string, file: string, cached: Mapped): Promise<{ code: string; inserted: Array<[number, number]> }> {
  const recorded = cached.lineLengths;
  for (const format of ["esm", "cjs"] as const) {
    const output = await transform(source, {
      loader: file.endsWith("x") ? "tsx" : /\.[cm]?ts$/.test(file) ? "ts" : "js", sourcefile: file, format, target: `node${process.versions.node}`,
      sourcemap: true, sourcesContent: true, minifyWhitespace: true, keepNames: true,
    });
    let code = output.code.replace(/\n$/, "");
    let inserted: Array<[number, number]> = [];
    const ends = await dynamicImportEnds(code);
    const total = (lengths: number[]) => lengths.reduce((sum, length) => sum + length, 0);
    const lines = code.split("\n").length;
    const extra = total(recorded.slice(0, lines)) - code.replace(/\n/g, "").length;
    if (ends.length) {
      const width = extra / ends.length;
      // `.then(x=>x)` is the shortest placeholder.
      if (!Number.isInteger(width) || width < 11) continue;
      for (const end of [...ends].reverse()) code = `${code.slice(0, end)}.then(x=>x${" ".repeat(width - 11)})${code.slice(end)}`;
      inserted = ends.map((end, index) => [end + index * width, end + (index + 1) * width]);
    } else if (extra !== 0) continue;
    // Node's lengths also cover the appended sourceMappingURL comment line.
    if (code.split("\n").every((line, index) => recorded[index] === line.length)) return { code, inserted };
  }
  throw new Error(`Cannot reproduce the tsx transform of ${file}`);
}

/**
 * Convert the raw NODE_V8_COVERAGE receipts of subprocess suites into Istanbul
 * shards compatible with the gate, one per receipt. `required` lists suites whose
 * absence is an error, as is a receipt that holds no dump or no repository source.
 * Raw dumps are deleted once converted; a rerun with only shards left reuses them.
 */
export async function convertSubprocessCoverage(root: string, directory: string, required: string[] = []) {
  const raw = subprocessRawDirectory(directory);
  if (existsSync(raw)) {
    const registry = new Map<string, string>();
    const registryDirectory = subprocessBundleRegistry(directory);
    for (const name of existsSync(registryDirectory) ? readdirSync(registryDirectory) : []) {
      const { url, code } = JSON.parse(readFileSync(join(registryDirectory, name), "utf8")) as { url: string; code: string };
      registry.set(url, code);
    }
    const included = new Set(await sourceManifest(root));
    for (const receipt of readdirSync(raw, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name).sort()) {
      const dumps = readdirSync(join(raw, receipt)).filter(name => /^coverage-.*\.json$/.test(name))
        .map(name => JSON.parse(readFileSync(join(raw, receipt, name), "utf8")) as NodeDump);
      if (!dumps.length) throw new Error(`Subprocess wrote no coverage: ${receipt}`);
      const report = await convertDumps(root, dumps, included, registry);
      if (!Object.keys(report).length) throw new Error(`Subprocess covered no repository source: ${receipt}`);
      writeFileSync(resolve(directory, `${receipt}.json`), JSON.stringify(report));
    }
    rmSync(raw, { recursive: true, force: true });
    rmSync(registryDirectory, { recursive: true, force: true });
  }
  const shards = existsSync(directory) ? readdirSync(directory).filter(name => name.endsWith(".json")).sort() : [];
  for (const suite of required) {
    if (!shards.some(name => name.startsWith(`${suite}-`))) throw new Error(`Missing subprocess coverage: ${suite}`);
  }
  return shards.map(name => resolve(directory, name));
}

export async function convertDumps(root: string, dumps: NodeDump[], included: Set<string>, registry: Map<string, string>) {
  const scripts = new Map<string, Profiler.ScriptCoverage[]>();
  const maps = new Map<string, Mapped>();
  for (const dump of dumps) {
    for (const script of dump.result) {
      if (script.url.startsWith("file:")) scripts.set(script.url, [...scripts.get(script.url) ?? [], script]);
    }
    for (const [url, entry] of Object.entries(dump["source-map-cache"] ?? {})) {
      if (entry?.data) maps.set(url, { lineLengths: entry.lineLengths, data: entry.data });
    }
  }
  const result: CoverageMapData = {};
  for (const [url, samples] of scripts) {
    const path = fileURLToPath(url);
    const name = tryCanonical(root, url);
    const map = maps.get(url);
    const bundle = registry.get(url);
    const mapsAuthored = map?.data.sources.some(source => included.has(tryCanonical(root, source) ?? source));
    if (!bundle && !(name && included.has(name))) {
      // A dependency or Node-internal script. Anything else that maps to
      // authored files but was not registered would silently drop coverage.
      if (mapsAuthored) throw new Error(`Unregistered subprocess bundle: ${url}`);
      continue;
    }
    const coverage = mergeScriptCovs(samples.map(sample => ({ ...sample, url })))!;
    let files: Array<{ path: string; name: string; file: FileCoverageData }>;
    if (bundle) {
      if (!map) throw new Error(`Missing source map: ${url}`);
      files = await convertMapped({ code: bundle, map: map.data, coverage, root, included });
    } else if (map) {
      const { code, inserted } = await reproduceTsxModule(readFileSync(path, "utf8"), path, map);
      files = await convertMapped({ code, map: map.data, coverage, root, included, ignoredRanges: inserted });
    } else {
      if (!path.endsWith(".js") && !path.endsWith(".mjs")) throw new Error(`Missing source map: ${url}`);
      // Plain JavaScript runs unmodified: V8 offsets are source offsets.
      const code = readFileSync(path, "utf8");
      const converted = await convert({ code, ast: parseAstAsync(code), coverage: { ...coverage, url: pathToFileURL(path).href } });
      files = Object.entries(converted).map(([filePath, file]) => ({ path: filePath, name: name!, file }));
    }
    // Re-printed code (tsx, bundles) differs from the gate's reference transform
    // only in spans; re-key every hit onto the canonical maps, or fail.
    for (const { path: filePath, name: fileName, file } of files) {
      const { canonical } = await canonicalCoverage(filePath);
      mergeBrowserFile(result, { ...alignCoverage(file, canonical, reprintedIdentities), path: fileName });
    }
  }
  return result;
}

function tryCanonical(root: string, source: string) {
  try { return canonicalPath(root, source); } catch { return undefined; }
}
