import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The subset of Vitest's JSON reporter output that identifies a test and its outcome. */
export type OutcomeReport = { testResults: Array<{ name: string; assertionResults: Array<{ fullName: string; status: string }> }> };

/** Compare per-test outcomes by file, full name and occurrence (same-titled tests stay distinct). */
export function diffOutcomes(left: OutcomeReport, right: OutcomeReport) {
  function outcomes(report: OutcomeReport) {
    const result = new Map<string, { file: string; test: string; status: string }>();
    for (const file of report.testResults) {
      const seen = new Map<string, number>();
      for (const { fullName, status } of file.assertionResults) {
        const occurrence = seen.get(fullName) ?? 0;
        seen.set(fullName, occurrence + 1);
        result.set(JSON.stringify([file.name, fullName, occurrence]), { file: file.name, test: fullName, status });
      }
    }
    return result;
  }
  const before = outcomes(left), after = outcomes(right);
  return [...new Set([...before.keys(), ...after.keys()])].sort().flatMap(key => {
    const a = before.get(key), b = after.get(key);
    const { file, test } = (a ?? b)!;
    return a?.status === b?.status ? [] : [{ file, test, before: a?.status ?? "missing", after: b?.status ?? "missing" }];
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [left, right] = process.argv.slice(2);
  if (!left || !right) throw new Error("Usage: tsx tests/helpers/diff-outcomes.ts first/outcomes.json second/outcomes.json");
  const differences = diffOutcomes(JSON.parse(readFileSync(left, "utf8")) as OutcomeReport, JSON.parse(readFileSync(right, "utf8")) as OutcomeReport);
  for (const difference of differences) console.log(JSON.stringify(difference));
  process.exitCode = differences.length ? 1 : 0;
}
