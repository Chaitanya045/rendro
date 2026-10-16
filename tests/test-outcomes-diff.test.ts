import { expect, it } from "vitest";
import { diffOutcomes, type OutcomeReport } from "./helpers/diff-outcomes";

const report = (...tests: Array<[string, string]>): OutcomeReport => ({
  testResults: [{ name: "tests/a.test.ts", assertionResults: tests.map(([fullName, status]) => ({ fullName, status })) }],
});

it("reports a test whose outcome, presence or same-titled occurrence differs between runs", () => {
  const first = report(["suite works", "passed"], ["suite flaky", "passed"], ["dup", "passed"], ["dup", "failed"]);
  expect(diffOutcomes(first, structuredClone(first))).toEqual([]);
  const second = report(["suite works", "passed"], ["suite flaky", "failed"], ["dup", "failed"], ["dup", "failed"], ["extra", "passed"]);
  expect(diffOutcomes(first, second)).toEqual([
    { file: "tests/a.test.ts", test: "dup", before: "passed", after: "failed" },
    { file: "tests/a.test.ts", test: "extra", before: "missing", after: "passed" },
    { file: "tests/a.test.ts", test: "suite flaky", before: "passed", after: "failed" },
  ]);
  expect(diffOutcomes(second, report())).toHaveLength(5);
  expect(diffOutcomes({ testResults: [] }, first)).toHaveLength(4);
});
