import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { CoverageMapData } from "istanbul-lib-coverage";

/** Compare hit/no-hit by source identity, including every branch arm and duplicate. */
export function diffCoverage(left: CoverageMapData, right: CoverageMapData) {
  function counters(report: CoverageMapData) {
    const result = new Map<string, { file: string; counter: string; location: unknown; hit: boolean }>();
    for (const [file, data] of Object.entries(report)) {
      for (const [counter, map] of [["s", "statementMap"], ["f", "fnMap"], ["b", "branchMap"]] as const) {
        const duplicates = new Map<string, number>();
        for (const [id, location] of Object.entries(data[map])) {
          const identity = JSON.stringify(location);
          const occurrence = duplicates.get(identity) ?? 0;
          duplicates.set(identity, occurrence + 1);
          const counts = counter === "b" ? data.b[id] : [data[counter][id]];
          counts.forEach((count, arm) => {
            result.set(JSON.stringify([file, counter, identity, occurrence, arm]), {
              file, counter: `${counter}:${id}${counter === "b" ? `:${arm}` : ""}`, location, hit: count > 0,
            });
          });
        }
      }
    }
    return result;
  }
  const before = counters(left), after = counters(right);
  return [...new Set([...before.keys(), ...after.keys()])].sort().flatMap(key => {
    const a = before.get(key), b = after.get(key);
    return a?.hit === b?.hit ? [] : [{ ...(a ?? b), before: a?.hit ?? "missing", after: b?.hit ?? "missing" }];
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [left, right] = process.argv.slice(2);
  if (!left || !right) throw new Error("Usage: tsx tests/helpers/diff-coverage.ts before/coverage-final.json after/coverage-final.json");
  const differences = diffCoverage(JSON.parse(readFileSync(left, "utf8")) as CoverageMapData, JSON.parse(readFileSync(right, "utf8")) as CoverageMapData);
  // An empty stdout is the acceptance signal; a difference also exits nonzero.
  for (const difference of differences) console.log(JSON.stringify(difference));
  process.exitCode = differences.length ? 1 : 0;
}
