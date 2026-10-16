import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import libCoverage from "istanbul-lib-coverage";
import { afterEach, expect, it } from "vitest";
import { mergeBrowserFile } from "./helpers/browser-coverage";
import { browserCoverageShards } from "./helpers/run-browser-coverage";
import { normalizeNodeFile } from "./helpers/normalize-node-coverage";
import { diffCoverage } from "./helpers/diff-coverage";

it("diffs hit status by location, retaining duplicates and individual branch arms", () => {
  const file = libCoverage.createFileCoverage("src/file.ts").data;
  const loc = { start: { line: 3, column: 2 }, end: { line: 3, column: 12 } };
  file.statementMap = { "0": loc, "1": loc }; file.s = { "0": 1, "1": 0 };
  file.fnMap = { "0": { name: "run", decl: loc, loc, line: 3 } }; file.f = { "0": 1 };
  file.branchMap = { "0": { type: "if", line: 3, loc, locations: [loc, loc] } }; file.b = { "0": [1, 0] };
  const before = { [file.path]: file }, after = structuredClone(before);
  after[file.path].s["0"] = 99;
  expect(diffCoverage(before, after)).toEqual([]);
  after[file.path].s["1"] = 1;
  after[file.path].b["0"] = [0, 1];
  after[file.path].f["0"] = 0;
  expect(diffCoverage(before, after)).toHaveLength(4);
  expect(diffCoverage(before, {})).toHaveLength(5);
  expect(diffCoverage({}, before)).toHaveLength(5);
  const renumbered = structuredClone(before);
  renumbered[file.path].fnMap = { "8": file.fnMap["0"] }; renumbered[file.path].f = { "8": 1 };
  expect(diffCoverage(before, renumbered)).toEqual([]);
});

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

it("requires a receipt from every browser suite and at least one nonempty shard", () => {
  const dir = mkdtempSync(join(tmpdir(), "rendro-browser-shards-"));
  dirs.push(dir);
  const suites = ["tests/first-browser.test.ts", "tests/second-browser.test.ts"];
  expect(() => browserCoverageShards(dir, suites)).toThrow("Missing browser coverage: tests/first");
  writeFileSync(join(dir, "first-browser.test.ts-1.json"), "{}");
  expect(() => browserCoverageShards(dir, suites)).toThrow("Missing browser coverage: tests/second");
  writeFileSync(join(dir, "second-browser.test.ts-2.json"), "{}");
  expect(() => browserCoverageShards(dir, suites)).toThrow("No browser source coverage");
  writeFileSync(join(dir, "first-browser.test.ts-1.json"), JSON.stringify({ "src/file.ts": {} }));
  expect(browserCoverageShards(dir, suites)).toEqual([join(dir, "first-browser.test.ts-1.json")]);
  writeFileSync(join(dir, "second-browser.test.ts-2.json"), "invalid JSON");
  expect(() => browserCoverageShards(dir, suites)).toThrow();
});

it("adds matching counters without collapsing distinct branch arms and rejects map drift", () => {
  const file = libCoverage.createFileCoverage("src/file.ts").data;
  const loc = { start: { line: 1, column: 0 }, end: { line: 1, column: 10 } };
  file.statementMap = { "7": loc }; file.s = { "7": 1 };
  file.fnMap = { "8": { name: "run", decl: loc, loc, line: 1 } }; file.f = { "8": 2 };
  file.branchMap = { "9": { type: "if", line: 1, loc, locations: [loc, loc] } };
  file.b = { "9": [3, -1] };
  const report = {};
  mergeBrowserFile(report, file);
  mergeBrowserFile(report, file);
  const merged = libCoverage.createCoverageMap(report).fileCoverageFor(file.path);
  expect(merged.s).toEqual({ "0": 2 });
  expect(merged.f).toEqual({ "0": 4 });
  expect(merged.b).toEqual({ "0": [6, 0] });
  file.statementMap["7"].end.line = 2;
  expect(() => mergeBrowserFile(report, file)).toThrow("Incompatible browser maps");
});

it("bridges only reproduced SSR maps and keeps collapsed arrow statements uncovered", () => {
  const canonical = libCoverage.createFileCoverage("src/file.ts").data;
  const loc = { start: { line: 1, column: 8 }, end: { line: 1, column: 30 } };
  canonical.statementMap = { "0": loc, "1": { ...loc, start: { line: 1, column: 15 } } };
  canonical.s = { "0": 0, "1": 0 };
  canonical.fnMap = { "0": { name: "run", decl: loc, loc, line: 1 } }; canonical.f = { "0": 0 };
  canonical.branchMap = { "0": { type: "binary-expr", line: 1, loc, locations: [loc, loc] } }; canonical.b = { "0": [0, 0] };
  const ssr = structuredClone(canonical);
  delete ssr.statementMap["1"]; delete ssr.s["1"];
  ssr.fnMap["0"].loc = { ...loc, start: { line: 1, column: 7 } };
  ssr.branchMap["0"].locations[1] = { ...loc, start: { line: 1, column: 7 } };
  const actual = structuredClone(ssr);
  actual.s["0"] = 2; actual.f["0"] = 3; actual.b["0"] = [4, -1];
  const normalized = normalizeNodeFile(actual, ssr, canonical);
  expect(normalized.s).toEqual({ "0": 2, "1": 0 });
  expect(normalized.f).toEqual({ "0": 3 });
  expect(normalized.b).toEqual({ "0": [4, 0] });
  expect(normalized.statementMap).toEqual(canonical.statementMap);
  expect(normalized.fnMap).toEqual(canonical.fnMap);
  expect(normalized.branchMap).toEqual(canonical.branchMap);
  actual.statementMap["0"].end.line = 2;
  expect(() => normalizeNodeFile(actual, ssr, canonical)).toThrow("Unexpected Node coverage transform");
});

it("rejects ambiguous endpoints, changed branch arms and missing function identities", () => {
  const file = libCoverage.createFileCoverage("src/file.ts").data;
  const loc = { start: { line: 1, column: 1 }, end: { line: 1, column: 10 } };
  file.statementMap = { "0": loc }; file.s = { "0": 1 };
  const canonical = structuredClone(file);
  canonical.statementMap["0"].start.column = 2;
  canonical.statementMap["1"] = { ...loc, start: { line: 1, column: 3 } }; canonical.s["1"] = 0;
  expect(() => normalizeNodeFile(file, file, canonical)).toThrow("Ambiguous coverage transform");
  delete canonical.statementMap["1"]; delete canonical.s["1"];
  expect(normalizeNodeFile(file, file, canonical).s).toEqual({ "0": 1 });
  file.branchMap = { "0": { type: "if", line: 1, loc, locations: [loc] } }; file.b = { "0": [1] };
  canonical.branchMap = { "0": { type: "if", line: 1, loc, locations: [loc, loc] } }; canonical.b = { "0": [0, 0] };
  expect(() => normalizeNodeFile(file, file, canonical)).toThrow("Ambiguous coverage transform");
  canonical.branchMap = file.branchMap; canonical.b = file.b;
  canonical.fnMap = { "0": { name: "run", decl: loc, loc, line: 1 } }; canonical.f = { "0": 0 };
  expect(() => normalizeNodeFile(file, file, canonical)).toThrow("Missing coverage identities");
});
