import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import convert from "ast-v8-to-istanbul";
import { transform } from "esbuild";
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
  const result = structuredClone(canonical);
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
      const identity = (file: FileCoverageData, key: string) => {
        if (counter === "s") return [file.statementMap[key].start.line, file.statementMap[key].end];
        if (counter === "f") return [file.fnMap[key].decl, file.fnMap[key].loc.end];
        const branch = file.branchMap[key];
        return [branch.type, branch.loc.start.line, branch.loc.end, branch.locations.map(loc => loc.end)];
      };
      const candidates = [...available].filter(key => fingerprint(identity(actual, id)) === fingerprint(identity(canonical, key)));
      if (candidates.length !== 1) throw new Error(`Ambiguous coverage transform: ${actual.path} ${counter}:${id}`);
      pairs.set(id, candidates[0]); available.delete(candidates[0]);
    }
    if (counter !== "s" && available.size) throw new Error(`Missing coverage identities: ${actual.path} ${counter}`);
    for (const [from, to] of pairs) {
      if (counter === "b") result.b[to] = actual.b[from].map(count => Math.max(0, count));
      else result[counter][to] = actual[counter][from];
    }
  }
  return result;
}

export async function normalizeNodeCoverage(root: string, nodeShard: string, browserShards: string[]) {
  const browserFiles = new Set(browserShards.flatMap(path => Object.keys(JSON.parse(readFileSync(path, "utf8")) as CoverageMapData)));
  const report = JSON.parse(readFileSync(nodeShard, "utf8")) as CoverageMapData;
  for (const [path, actual] of Object.entries(report)) {
    const name = canonicalPath(root, path);
    if (!browserFiles.has(name)) continue;
    const absolute = resolve(root, name);
    const output = await transform(readFileSync(absolute, "utf8"), { loader: "ts", sourcefile: absolute, sourcemap: "external", target: "esnext" });
    const sourceMap = JSON.parse(output.map) as Rollup.SourceMap;
    const coverage = { url: pathToFileURL(absolute).href, functions: [] };
    const canonical = (await convert({ code: output.code, sourceMap, ast: parseAstAsync(output.code), coverage }))[absolute];
    const transformed = await moduleRunnerTransform(output.code, sourceMap, absolute, output.code);
    if (!transformed?.map || !("version" in transformed.map)) throw new Error(`Missing SSR transform: ${name}`);
    const ssr = (await convert({ code: transformed.code, sourceMap: transformed.map, ast: parseAstAsync(transformed.code), coverage,
      ignoreNode: (node, type) => type === "statement" && (
        (node.type === "VariableDeclarator" && node.id.type === "Identifier" && node.id.name.startsWith("__vite_ssr_")) ||
        (node.type === "ExpressionStatement" && node.expression.type === "AssignmentExpression" && node.expression.left.type === "MemberExpression" && node.expression.left.object.type === "Identifier" && node.expression.left.object.name === "__vite_ssr_exports__")
      ),
    }))[absolute];
    report[path] = normalizeNodeFile(actual, ssr, canonical);
  }
  const output = resolve(root, "coverage/node-canonical.json");
  writeFileSync(output, JSON.stringify(report));
  return output;
}
