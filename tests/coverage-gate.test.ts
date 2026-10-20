import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FileCoverageData } from "istanbul-lib-coverage";
import { canonicalPath, checkLedger, checkLedgerHistory, main, mergeReports, metrics, runGate, sourceManifest } from "../scripts/coverage-gate";
import type { Ledger } from "../scripts/coverage-gate";
import { coveragePolicy } from "../scripts/coverage-policy";
import config from "../vitest.config";
import partial from "./fixtures/coverage/partial.json";

const repo = fileURLToPath(new URL("..", import.meta.url));
const script = join(repo, "scripts/coverage-gate.ts");
const source = "export function example(ok: boolean) {\n  if (ok) return 1;\n  return 0;\n}\n";
const zero = { statements: 0, branches: 0, functions: 0, lines: 0 };
const debt = { statements: 1, branches: 1, functions: 0, lines: 1 };
const ledger: Ledger = { version: 1, files: { "src/example.ts": debt } };
let root: string;
function write(name: string, content: string) {
  const path = join(root, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}
function json(name: string, value: unknown) { write(name, JSON.stringify(value)); }
function file(): FileCoverageData { return structuredClone(partial["src/example.ts"]); }
function full() {
  const data = file();
  data.s["1"] = 1;
  data.b["0"][1] = 1;
  return data;
}
function git(...args: string[]) { return execFileSync("git", args, { cwd: root, encoding: "utf8" }); }

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "rendro-coverage-"));
  write("src/example.ts", source);
  json("shard.json", partial);
  json("coverage-debt.json", ledger);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

describe("coverage source policy", () => {
  it("matches only authored root trees, including Node entry and mjs scripts", async () => {
    const included = ["src/example.ts", "src/index.ts", "convex/auth.ts", "shared/x.ts", "scripts/build.mjs", "scripts/nested/x.ts", "src/.hidden.ts"];
    const excluded = ["src/types.d.ts", "convex/_generated/api.ts", "convex/betterAuth/_generated/api.ts", "convex/betterAuth/schema.generated.ts", "tests/src/x.ts", "cli/src/index.ts", "vendor/cli/src/index.ts", "scripts/no.js", "src/no.tsx", "public/build.js", "src/not-code.ts/child.js"];
    for (const name of [...included, ...excluded]) write(name, "export const x = 1;");
    expect(await sourceManifest(root)).toEqual(included.sort());
    // Exercise the installed Vitest matcher's contains:true semantics explicitly.
    const pm = createRequire(import.meta.resolve("vitest/node"))("picomatch") as { isMatch: (path: string, globs: string[], options: { contains: boolean; dot: boolean; ignore: string[] }) => boolean };
    const policy = coveragePolicy(root);
    for (const name of included) expect(pm.isMatch(join(root, name), policy.include, { contains: true, dot: true, ignore: policy.exclude }), name).toBe(true);
    for (const name of excluded) expect(pm.isMatch(join(root, name), policy.include, { contains: true, dot: true, ignore: policy.exclude }), name).toBe(false);
    expect(config.test?.coverage).toMatchObject({ ...coveragePolicy(repo), excludeAfterRemap: true, reportOnFailure: true, reporter: ["json", "json-summary", "lcov", "text"] });
  });

  it("rejects an empty manifest", async () => {
    rmSync(join(root, "src"), { recursive: true });
    await expect(sourceManifest(root)).rejects.toThrow("Empty source manifest");
  });
});

describe("Istanbul shard merge", () => {
  it("merges canonical paths and location-matched counters, never file percentages", async () => {
    const other = file();
    other.path = pathToFileURL(join(root, "src/example.ts")).href;
    other.s = { "9": 0, "8": 1 };
    other.statementMap = { "9": other.statementMap["0"], "8": other.statementMap["1"] };
    other.b["0"] = [0, 1];
    json("other.json", { [join(root, "src/example.ts")]: other, "tests/ignored.ts": {} });
    const result = await mergeReports(root, ["shard.json", "other.json"]);
    expect(result.missing).toEqual([]);
    expect(result.debt).toEqual({ "src/example.ts": zero });
    expect(result.summary.total.statements).toMatchObject({ covered: 2, total: 2 });
    expect(result.summary.total.branches).toMatchObject({ covered: 2, total: 2 });
    expect(canonicalPath(root, "src\\example.ts")).toBe("src/example.ts");
    expect(canonicalPath(root, "src/../src/example.ts")).toBe("src/example.ts");
  });

  it("preserves remapped end columns, implicit arms, and branches sharing a location", async () => {
    const data = structuredClone(partial["src/example.ts"]);
    const branch = data.branchMap["0"];
    const remapped = {
      ...data,
      statementMap: { ...data.statementMap, "0": { ...data.statementMap["0"], end: { line: 2, column: null } } },
      branchMap: {
        "0": { ...branch, locations: [branch.locations[0], { start: {}, end: {} }] },
        "1": { ...branch, type: "cond-expr" },
      },
      b: { "0": [1, -5], "1": [0, 1] },
    };
    json("shard.json", { "src/example.ts": remapped });
    json("other.json", { "src/example.ts": { ...remapped, b: { "0": [0, 1], "1": [1, 0] } } });
    const result = await mergeReports(root, ["shard.json", "other.json"]);
    expect(result.summary.total.branches).toMatchObject({ covered: 4, total: 4 });
    expect(result.summary.total.statements).toMatchObject({ covered: 1, total: 2 });
    expect(result.merged.fileCoverageFor("src/example.ts").statementMap["0"].end.column).toBeNull();
  });

  it("seeds absent TypeScript and mjs sources with executable zero counters", async () => {
    write("shared/missing.ts", source);
    write("scripts/missing.mjs", "export const f = (ok) => ok ? 1 : 0;\n");
    const result = await mergeReports(root, ["shard.json"]);
    expect(result.missing).toEqual(["scripts/missing.mjs", "shared/missing.ts"]);
    for (const name of result.missing) for (const metric of metrics) expect(result.debt[name][metric]).toBeGreaterThan(0);
    expect(result.summary.total.statements.covered).toBe(1);
    expect(result.summary.total.statements.total).toBeGreaterThan(2);
    await expect(runGate(root, ["--update-ledger", "shard.json"])).rejects.toThrow("missing from every shard");
    expect(JSON.parse(readFileSync(join(root, "coverage-debt.json"), "utf8"))).toEqual(ledger);
    expect(JSON.parse(readFileSync(join(root, "coverage/merged/coverage-summary.json"), "utf8"))).toHaveProperty("shared/missing.ts");
  });

  it("seeds an absent type-only module without inventing executable counters", async () => {
    write("shared/types.ts", "export type Empty = string;\n");
    const result = await mergeReports(root, ["shard.json"]);
    expect(result.missing).toEqual(["shared/types.ts"]);
    expect(result.debt["shared/types.ts"]).toEqual(zero);
    expect(result.summary["shared/types.ts"].statements.total).toBe(0);
  });

  it.each(["", "{}", "[]", "null", "{", '{"tests/ignored.ts":{}}'])("rejects empty/invalid shards: %s", async content => {
    write("empty.json", content);
    await expect(mergeReports(root, ["shard.json", "empty.json"])).rejects.toThrow();
  });
  it("requires all requested shards and at least one shard", async () => {
    await expect(mergeReports(root, [])).rejects.toThrow("at least one");
    await expect(mergeReports(root, ["shard.json", "absent.json"])).rejects.toThrow("ENOENT");
  });
  it.each(["..", "../outside.ts", "C:\\other\\src.ts", "."])("rejects outside paths %s", name => {
    expect(() => canonicalPath(root, name)).toThrow("outside repository");
  });
  it("rejects key/path disagreement", async () => {
    json("shard.json", { "src/example.ts": { ...file(), path: "src/different.ts" } });
    await expect(mergeReports(root, ["shard.json"])).rejects.toThrow("key/path mismatch");
  });
  it.each(["statementMap", "fnMap", "branchMap"] as const)("rejects incompatible %s", async map => {
    const data = file();
    if (map === "statementMap") data.statementMap["0"].start.column++;
    else data[map]["0"].loc.start.column++;
    json("different.json", { "src/example.ts": data });
    await expect(mergeReports(root, ["shard.json", "different.json"])).rejects.toThrow("Incompatible coverage maps");
  });
  it("rejects counter/map mismatch and malformed counts", async () => {
    const data = file();
    delete data.s["0"];
    json("bad.json", { "src/example.ts": data });
    await expect(mergeReports(root, ["bad.json"])).rejects.toThrow("Counter/map mismatch");
    data.s["0"] = -1;
    json("bad.json", { "src/example.ts": data });
    await expect(mergeReports(root, ["bad.json"])).rejects.toThrow();
    data.s["0"] = 1;
    data.b["0"] = [1];
    json("bad.json", { "src/example.ts": data });
    await expect(mergeReports(root, ["bad.json"])).rejects.toThrow("Branch/map mismatch");
  });
});

describe("debt gate", () => {
  it("passes the baseline and prints summed covered/total", async () => {
    await runGate(root, ["shard.json"]);
    expect(console.log).toHaveBeenCalledWith("statements: 1/2 (50.00%)");
    expect(console.log).toHaveBeenCalledWith("branches: 1/2 (50.00%)");
    expect(console.log).toHaveBeenCalledWith("functions: 1/1 (100.00%)");
    expect(console.log).toHaveBeenCalledWith("lines: 1/2 (50.00%)");
  });
  it.each(metrics)("rejects increased %s even in update mode", metric => {
    const increased = { ...debt, [metric]: debt[metric] + 1 };
    expect(checkLedger({ "src/example.ts": increased }, ledger, true).errors).toEqual([expect.stringContaining(`uncovered ${metric}`)]);
  });
  it("requires all four metrics for new files and removes stale entries", () => {
    expect(checkLedger({ "src/new.ts": debt }, ledger, false).errors).toContainEqual(expect.stringContaining("src/new.ts"));
    expect(checkLedger({ "src/example.ts": zero }, ledger, false).errors).toEqual([expect.stringContaining("delete stale entry")]);
    expect(checkLedger({ "src/example.ts": zero }, ledger, true)).toEqual({ errors: [], next: { version: 1, files: {} } });
    expect(checkLedger({ "src/new.ts": zero }, { version: 1, files: {} }, false).errors).toEqual([]);
  });
  it("updates only downward and refuses any partial write on regression", async () => {
    const larger = { version: 1, files: { "src/example.ts": { statements: 2, branches: 2, functions: 1, lines: 2 }, "src/deleted.ts": debt } };
    json("coverage-debt.json", larger);
    await runGate(root, ["--update-ledger", "shard.json"]);
    expect(JSON.parse(readFileSync(join(root, "coverage-debt.json"), "utf8"))).toEqual(ledger);
    json("coverage-debt.json", { version: 1, files: {} });
    await expect(runGate(root, ["--update-ledger", "shard.json"])).rejects.toThrow("debt cannot increase");
    expect(JSON.parse(readFileSync(join(root, "coverage-debt.json"), "utf8"))).toEqual({ version: 1, files: {} });
  });
  it("fails stale entries until deleted, including via --update-ledger", async () => {
    json("shard.json", { "src/example.ts": full() });
    await expect(runGate(root, ["shard.json"])).rejects.toThrow("delete stale entry");
    await runGate(root, ["shard.json", "--update-ledger"]);
    await runGate(root, ["shard.json"]);
    expect(JSON.parse(readFileSync(join(root, "coverage-debt.json"), "utf8"))).toEqual({ version: 1, files: {} });
  });
  it("reports empty executable denominators as N/A", async () => {
    write("src/example.ts", "export type Empty = string;\n");
    json("shard.json", { "src/example.ts": { path: "src/example.ts", statementMap: {}, fnMap: {}, branchMap: {}, s: {}, f: {}, b: {} } });
    json("coverage-debt.json", { version: 1, files: {} });
    await runGate(root, ["shard.json"]);
    for (const metric of metrics) expect(console.log).toHaveBeenCalledWith(`${metric}: 0/0 (N/A)`);
  });
  it("rejects unknown options and absent/malformed ledgers", async () => {
    await expect(runGate(root, ["--grow-ledger"])).rejects.toThrow("Unknown");
    json("coverage-debt.json", { version: 2, files: {} });
    await expect(runGate(root, ["shard.json"])).rejects.toThrow();
    rmSync(join(root, "coverage-debt.json"));
    await expect(runGate(root, ["shard.json"])).rejects.toThrow("ENOENT");
  });
});

describe("ledger history and CLI", () => {
  it("allows initial rollout and shrinking but rejects hand-edited increases", async () => {
    git("init", "--quiet");
    git("add", "src");
    git("-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "--quiet", "-m", "Source");
    checkLedgerHistory(root, ledger, "0000");
    checkLedgerHistory(root, ledger, "HEAD");
    git("add", "coverage-debt.json");
    git("-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "--quiet", "-m", "Debt");
    await runGate(root, ["shard.json"], "HEAD");
    checkLedgerHistory(root, { version: 1, files: {} }, "HEAD");
    expect(() => checkLedgerHistory(root, { version: 1, files: { "src/new.ts": zero } }, "HEAD")).toThrow("new ledger entries");
    expect(() => checkLedgerHistory(root, { version: 1, files: { "src/example.ts": { ...debt, functions: 1 } } }, "HEAD")).toThrow("debt cannot increase");
    expect(() => checkLedgerHistory(root, ledger, "missing-ref")).toThrow();
  });
  it("runs the actual command with correct success/failure exit status", () => {
    const tsx = join(repo, "node_modules/tsx/dist/cli.mjs");
    const success = spawnSync(process.execPath, [tsx, script, "shard.json"], { cwd: root, encoding: "utf8", timeout: 10_000, env: { ...process.env, COVERAGE_DEBT_BASE: "" } });
    expect(success.status, success.stderr).toBe(0);
    const failure = spawnSync(process.execPath, [tsx, script, "missing.json"], { cwd: root, encoding: "utf8", timeout: 10_000 });
    expect(failure.status, failure.stderr).toBe(1);
  }, 30_000); // Two cold Node/tsx starts have their own bounded process deadlines.
  it("covers the executable entry and reports failures without exiting the worker", async () => {
    const argv = process.argv;
    const exitCode = process.exitCode;
    vi.spyOn(process, "cwd").mockReturnValue(root);
    vi.stubEnv("COVERAGE_DEBT_BASE", "");
    try {
      process.argv = [process.execPath, script, "shard.json"];
      vi.resetModules();
      await import("../scripts/coverage-gate");
      expect(console.log).toHaveBeenCalledWith("Coverage gate passed (1 source files).");
      process.argv = [process.execPath];
      vi.resetModules();
      await import("../scripts/coverage-gate");
      await main();
      expect(process.exitCode).toBe(1);
      expect(console.error).toHaveBeenCalled();
    } finally {
      process.argv = argv;
      process.exitCode = exitCode;
    }
  });
});
