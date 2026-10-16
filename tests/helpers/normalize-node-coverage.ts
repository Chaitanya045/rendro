import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import convert from "ast-v8-to-istanbul";
import { transform, type TransformResult } from "esbuild";
import type { CoverageMapData, FileCoverageData } from "istanbul-lib-coverage";
import { moduleRunnerTransform, type Rollup } from "vite";
import { parseAstAsync } from "vitest/node";
import { canonicalPath } from "../../scripts/coverage-gate";

const maps = ["statementMap", "fnMap", "branchMap"] as const;
const fingerprint = (value: unknown) => JSON.stringify(value);
const sorted = (value: object) => Object.values(value).map(fingerprint).sort();

/** Only bridge the two independently reproduced transforms, never arbitrary reports. */
export function normalizeNodeFile(actual: FileCoverageData, ssr: FileCoverageData, canonical: FileCoverageData) {
  for (const map of maps) {
    if (fingerprint(sorted(actual[map])) !== fingerprint(sorted(ssr[map]))) throw new Error(`Unexpected Node coverage transform: ${actual.path} ${map}`);
  }
  return alignCoverage(actual, canonical);
}

type Counter = "s" | "f" | "b";
/** Identity of one map entry that survives a re-print: the default also keys functions by declaration. */
export type Identity = (file: FileCoverageData, counter: Counter, key: string) => unknown;
export const sourceIdentity: Identity = (file, counter, key) => {
  if (counter === "s") return [file.statementMap[key].start.line, file.statementMap[key].end];
  if (counter === "f") return [file.fnMap[key].decl, file.fnMap[key].loc.end];
  const branch = file.branchMap[key];
  return [branch.type, branch.loc.start.line, branch.loc.end, branch.locations.map(loc => loc.end)];
};
/** Rewritten nested conditionals can move a branch's own start; its arms keep their ends. */
export const armIdentity: Identity = (file, counter, key) =>
  counter === "b" ? [file.branchMap[key].type, file.branchMap[key].locations.map(loc => loc.end)] : sourceIdentity(file, counter, key);
/** Re-printed code (tsx: minified whitespace, keepNames wrappers) moves declaration spans and the end of wrapped declarators. */
export const reprintedIdentities: Identity[] = [
  (file, counter, key) => counter === "f" ? file.fnMap[key].loc : sourceIdentity(file, counter, key),
  (file, counter, key) => counter === "s" ? file.statementMap[key].start : counter === "f" ? file.fnMap[key].loc.start : file.branchMap[key].loc.start,
  // A multi-line initializer can start on the previous line once re-printed.
  (file, counter, key) => counter === "s" ? file.statementMap[key].end : counter === "f" ? file.fnMap[key].loc.end : file.branchMap[key].loc.end,
  armIdentity,
];

/** Re-key `actual` hit counts onto the canonical maps; ambiguous or missing identities are errors. */
export function alignCoverage(actual: FileCoverageData, canonical: FileCoverageData, identities: Identity[] = [sourceIdentity, armIdentity]) {
  const result = structuredClone(canonical);
  let unpaired: string[] = [];
  for (const counter of ["s", "f", "b"] as const) {
    const map = counter === "s" ? "statementMap" : counter === "f" ? "fnMap" : "branchMap";
    const available = new Set(Object.keys(canonical[map]));
    const pairs = new Map<string, string>();
    // Exact identities take precedence, especially a variable declaration and
    // its expression-bodied arrow sharing an endpoint. SSR can collapse those
    // spans; the otherwise absent canonical statement retains zero hits.
    for (const [id, location] of Object.entries(actual[map])) {
      const match = [...available].find(key => fingerprint(canonical[map][key]) === fingerprint(location));
      if (match !== undefined) { pairs.set(id, match); available.delete(match); }
    }
    for (const id of Object.keys(actual[map])) {
      if (pairs.has(id)) continue;
      // Imports rewritten by Vite shift start columns, but retain source ends,
      // declaration spans, branch kind and the ordered endpoints of every arm.
      // Both complete maps were reproduced from this source revision above.
      // The first identity that selects exactly one canonical entry wins.
      const candidate = identities.map(identity => [...available].filter(key => fingerprint(identity(actual, counter, id)) === fingerprint(identity(canonical, counter, key))))
        .find(candidates => candidates.length === 1)?.[0];
      if (candidate === undefined) throw new Error(`Ambiguous coverage transform: ${actual.path} ${counter}:${id}`);
      pairs.set(id, candidate); available.delete(candidate);
    }
    if (counter !== "s" && available.size) throw new Error(`Missing coverage identities: ${actual.path} ${counter}`);
    if (counter === "s") unpaired = [...available];
    for (const [from, to] of pairs) {
      if (counter === "b") result.b[to] = actual.b[from].map(count => Math.max(0, count));
      else result[counter][to] = actual[counter][from];
    }
  }
  // SSR collapses a declaration and its expression-bodied arrow into one statement.
  // The absent body statement runs once per call: the hits of the function it fills.
  for (const id of unpaired) {
    const fn = Object.keys(canonical.fnMap).find(key => fingerprint(canonical.fnMap[key].loc) === fingerprint(canonical.statementMap[id]));
    if (fn !== undefined) result.s[id] = result.f[fn];
  }
  return result;
}

const executed = (file: FileCoverageData) => [...Object.values(file.s), ...Object.values(file.f), ...Object.values(file.b).flat()].some(hits => hits > 0);

/** The gate's own transform of one authored file, as its zero-hit reference map. */
export async function canonicalCoverage(absolute: string): Promise<{ canonical: FileCoverageData; output: TransformResult; sourceMap: Rollup.SourceMap; coverage: { url: string; functions: never[] } }> {
  const output = await transform(readFileSync(absolute, "utf8"), { loader: /\.[cm]?ts$/.test(absolute) ? "ts" : "js", sourcefile: absolute, sourcemap: "external", target: "esnext" });
  const sourceMap = JSON.parse(output.map) as Rollup.SourceMap;
  const coverage = { url: pathToFileURL(absolute).href, functions: [] };
  const canonical = (await convert({ code: output.code, sourceMap, ast: parseAstAsync(output.code), coverage }) as unknown as CoverageMapData)[absolute];
  return { canonical, output, sourceMap, coverage };
}

export async function normalizeNodeCoverage(root: string, nodeShard: string, browserShards: string[]) {
  const browserFiles = new Set(browserShards.flatMap(path => Object.keys(JSON.parse(readFileSync(path, "utf8")) as CoverageMapData)));
  const report = JSON.parse(readFileSync(nodeShard, "utf8")) as CoverageMapData;
  for (const [path, actual] of Object.entries(report)) {
    const name = canonicalPath(root, path);
    if (!browserFiles.has(name)) continue;
    const absolute = resolve(root, name);
    const { canonical, output, sourceMap, coverage } = await canonicalCoverage(absolute);
    const transformed = await moduleRunnerTransform(output.code, sourceMap, absolute, output.code);
    if (!transformed?.map || !("version" in transformed.map)) throw new Error(`Missing SSR transform: ${name}`);
    const ssr = (await convert({ code: transformed.code, sourceMap: transformed.map, ast: parseAstAsync(transformed.code), coverage,
      ignoreNode: (node, type) => type === "statement" && (
        (node.type === "VariableDeclarator" && node.id.type === "Identifier" && node.id.name.startsWith("__vite_ssr_")) ||
        (node.type === "ExpressionStatement" && node.expression.type === "AssignmentExpression" && node.expression.left.type === "MemberExpression" && node.expression.left.object.type === "Identifier" && node.expression.left.object.name === "__vite_ssr_exports__")
      ),
    }))[absolute];
    // Vitest lists a file it never executed with its own zero-hit map. Nothing there
    // to carry over: another shard (a subprocess) supplies every hit of the file.
    report[path] = executed(actual) ? normalizeNodeFile(actual, ssr, canonical) : canonical;
  }
  const output = resolve(root, "coverage/node-canonical.json");
  writeFileSync(output, JSON.stringify(report));
  return output;
}
