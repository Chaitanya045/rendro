import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import type { CoverageMapData } from "istanbul-lib-coverage";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sourceManifest } from "../scripts/coverage-gate";
import { convertDumps, convertSubprocessCoverage, reproduceTsxModule, type NodeDump } from "./helpers/merge-subprocess-coverage";
import { alignCoverage, canonicalCoverage, reprintedIdentities } from "./helpers/normalize-node-coverage";
import { subprocessSuites } from "./helpers/run-browser-coverage";
import { buildRegisteredBundle, SUBPROCESS_COVERAGE_DIR, subprocessArgs, subprocessEnv } from "./helpers/subprocess-coverage";

const root = process.cwd();
const directories: string[] = [];
let output: string;

/** Never the real `pnpm coverage` directory: these tests create deliberately empty or broken receipts. */
beforeEach(() => {
  output = mkdtempSync(join(tmpdir(), "rendro-subprocess-coverage-"));
  directories.push(output);
  vi.stubEnv(SUBPROCESS_COVERAGE_DIR, output);
});
afterEach(() => {
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const run = (args: string[], env = subprocessEnv()) => execFileSync(process.execPath, args, { cwd: root, env, encoding: "utf8", timeout: 60_000 });
const runTs = (code: string) => run(["--import", "tsx", "--input-type=module", "-e", code]);
const shardsOf = async (required: string[] = []) => convertSubprocessCoverage(root, output, required);
// Shards are stored in the gate's location order, JSON-encoded (Infinity columns as null).
const locations = (map: object) => Object.values(map).map(location => JSON.stringify(location)).sort();
const readShard = (path: string) => JSON.parse(readFileSync(path, "utf8")) as CoverageMapData;
// A script that runs as a bundle: its dry run makes no request and needs no credentials.
const bundled = "scripts/check-r2-public-access.ts";

describe("collector", () => {
  it("is a no-op without a collector directory", () => {
    vi.stubEnv(SUBPROCESS_COVERAGE_DIR, "");
    const env = { PATH: "x" };
    expect(subprocessEnv(env)).toBe(env);
    expect(subprocessArgs()).toEqual([]);
  });

  it("gives every subprocess its own receipt directory named after the suite", () => {
    const first = subprocessEnv({ KEEP: "1" });
    const second = subprocessEnv();
    expect(first.KEEP).toBe("1");
    expect(first.NODE_V8_COVERAGE).not.toBe(second.NODE_V8_COVERAGE);
    for (const env of [first, second]) {
      expect(env.NODE_V8_COVERAGE!.startsWith(join(output, "raw", "subprocess-coverage.test.ts-"))).toBe(true);
      expect(existsSync(env.NODE_V8_COVERAGE!)).toBe(true);
    }
    expect(subprocessArgs()).toEqual(["--import", resolve("tests/helpers/exit-on-sigterm.mjs")]);
  });

  it("builds a bundle with source maps only while collecting, registering what it wrote", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "rendro-subprocess-bundle-"));
    directories.push(scratch);
    await buildRegisteredBundle(bundled, join(scratch, "collected.mjs"));
    const collected = readFileSync(join(scratch, "collected.mjs"), "utf8");
    expect(collected).toContain("//# sourceMappingURL=data:application/json;base64,");
    const [registered] = readdirSync(join(output, "bundles")).map(name => JSON.parse(readFileSync(join(output, "bundles", name), "utf8")) as { url: string; code: string });
    expect(registered).toEqual({ url: pathToFileURL(join(scratch, "collected.mjs")).href, code: collected });

    vi.stubEnv(SUBPROCESS_COVERAGE_DIR, "");
    await buildRegisteredBundle(bundled, join(scratch, "plain.mjs"));
    expect(readFileSync(join(scratch, "plain.mjs"), "utf8")).not.toContain("sourceMappingURL");
    expect(readdirSync(join(output, "bundles"))).toHaveLength(1);
  });

  it("finds the suites that spawn through the collector", async () => {
    const project = mkdtempSync(join(tmpdir(), "rendro-subprocess-suites-"));
    directories.push(project);
    mkdirSync(join(project, "tests"));
    writeFileSync(join(project, "tests/spawns.test.ts"), "const env = subprocessEnv({});");
    writeFileSync(join(project, "tests/pure.test.ts"), "expect(1).toBe(1);");
    writeFileSync(join(project, "tests/subprocess-coverage.test.ts"), "subprocessEnv();");
    expect(await subprocessSuites(project)).toEqual(["spawns.test.ts"]);
    expect(await subprocessSuites()).toEqual(expect.arrayContaining(["build-scripts.test.ts", "repository-quality-gates.test.ts"]));
  });
});

describe("conversion", () => {
  it("maps a tsx-run TypeScript module onto the gate's canonical identities with its hit counts", async () => {
    runTs('const { isCanonicalStorageKey } = await import("./src/storage-boundary.ts"); console.log(isCanonicalStorageKey("a/b"));');
    const [shard] = await shardsOf(["subprocess-coverage.test.ts"]);
    const report = readShard(shard);
    const file = report["shared/storage-path.ts"];
    const { canonical } = await canonicalCoverage(resolve("shared/storage-path.ts"));
    for (const map of ["statementMap", "fnMap", "branchMap"] as const) expect(locations(file[map])).toEqual(locations(canonical[map]));
    const hits = Object.fromEntries(Object.entries(file.fnMap).map(([id, fn]) => [fn.name, file.f[id]]));
    expect(hits).toMatchObject({ isCanonicalStorageKey: 1, decodeStoragePath: 0 });
    // The module that re-exports it is reported too, under its repository-relative name.
    expect(Object.keys(report)).toContain("src/storage-boundary.ts");
    expect(readdirSync(output)).not.toContain("raw");
  });

  it("maps modules with dynamic imports and default exports, ignoring what tsx inserts", async () => {
    // The gate holds a dynamic import; the auth pages a default export.
    const modules = ["scripts/coverage-gate.ts", "src/routes/auth-pages.ts"];
    runTs(modules.map(path => `await import("./${path}");`).join(" "));
    const [shard] = await shardsOf();
    for (const path of modules) {
      const file = readShard(shard)[path];
      const { canonical } = await canonicalCoverage(resolve(path));
      for (const map of ["statementMap", "fnMap", "branchMap"] as const) expect(locations(file[map]), path).toEqual(locations(canonical[map]));
      expect(Object.values(file.s).some(count => count > 0), path).toBe(true);
    }
  }, 60_000);

  it("reproduces tsx's dynamic-import interop as same-length placeholders", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "rendro-subprocess-dynamic-"));
    directories.push(scratch);
    writeFileSync(join(scratch, "package.json"), '{"type":"module"}');
    const module = join(scratch, "dynamic.ts");
    writeFileSync(module, 'export async function load(): Promise<string> { const path = await import("node:path"); return path.sep; }\nawait load();\n');
    const env = subprocessEnv();
    run(["--import", "tsx", module], env);
    const url = pathToFileURL(module).href;
    const entry = readdirSync(env.NODE_V8_COVERAGE!).map(name => JSON.parse(readFileSync(join(env.NODE_V8_COVERAGE!, name), "utf8")) as NodeDump)
      .map(dump => dump["source-map-cache"]?.[url]).find(Boolean)!;
    const { code, inserted } = await reproduceTsxModule(readFileSync(module, "utf8"), module, entry as never);
    expect(inserted).toHaveLength(1);
    expect(code.slice(...inserted[0]).startsWith(".then(x=>x")).toBe(true);
    expect(code.slice(inserted[0][0] - 1, inserted[0][0])).toBe(")");
  });

  it("maps an esbuild bundle back to its authored sources", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "rendro-subprocess-bundle-"));
    directories.push(scratch);
    await buildRegisteredBundle(bundled, join(scratch, "check.mjs"));
    expect(run([join(scratch, "check.mjs"), "--dry-run"])).toContain("Dry run: no request was made.");
    const [shard] = await shardsOf();
    const report = readShard(shard);
    expect(Object.keys(report)).toContain(bundled);
    const script = report[bundled];
    const { canonical } = await canonicalCoverage(resolve(bundled));
    expect(locations(script.statementMap)).toEqual(locations(canonical.statementMap));
    expect(Object.values(script.s).some(count => count > 0)).toBe(true);
    expect(Object.values(script.s).some(count => count === 0)).toBe(true);
  }, 60_000);

  it("maps unmodified JavaScript scripts directly", async () => {
    // The repository has no JavaScript scripts left (#286), so a scratch project supplies one.
    const project = mkdtempSync(join(tmpdir(), "rendro-subprocess-plain-"));
    directories.push(project);
    mkdirSync(join(project, "scripts"));
    writeFileSync(join(project, "scripts/plain.mjs"), 'const pick = (flag) => flag ? "used" : "unused";\nfunction never() { return pick(false); }\nconsole.log(pick(true));\n');
    expect(execFileSync(process.execPath, ["scripts/plain.mjs"], { cwd: project, env: subprocessEnv(), encoding: "utf8", timeout: 60_000 })).toBe("used\n");
    const [shard] = await convertSubprocessCoverage(project, output, []);
    const file = readShard(shard)["scripts/plain.mjs"];
    expect(file.fnMap).toBeDefined();
    expect(Object.values(file.s).some(count => count > 0)).toBe(true);
    expect(Object.values(file.s).some(count => count === 0)).toBe(true);
  });

  it("merges every process of a receipt, tsx wrapper included", async () => {
    const receipt = subprocessEnv();
    run(["--import", "tsx", "-e", "0"], receipt);
    const bin = resolve("node_modules/.bin/tsx");
    execFileSync(bin, ["-e", 'import("./shared/storage-path.ts")'], { cwd: root, env: receipt, timeout: 60_000 });
    const [shard] = await shardsOf();
    expect(readdirSync(output)).not.toContain("raw");
    expect(Object.keys(readShard(shard))).toContain("shared/storage-path.ts");
  });

  it("keeps the shards for a rerun without raw dumps", async () => {
    runTs('await import("./shared/storage-path.ts");');
    const first = await shardsOf();
    expect(await shardsOf(["subprocess-coverage.test.ts"])).toEqual(first);
    await expect(shardsOf(["other.test.ts"])).rejects.toThrow("Missing subprocess coverage: other.test.ts");
  });
});

describe("fail closed", () => {
  it("errors when a required suite left no receipt", async () => {
    await expect(shardsOf(["build-scripts.test.ts"])).rejects.toThrow("Missing subprocess coverage: build-scripts.test.ts");
  });

  it("errors when a receipt stays empty, e.g. a child killed before exit", async () => {
    const env = subprocessEnv();
    await expect(shardsOf()).rejects.toThrow(`Subprocess wrote no coverage: ${env.NODE_V8_COVERAGE!.split("/").at(-1)}`);
  });

  it("errors when a receipt covered no repository source", async () => {
    const env = subprocessEnv();
    run(["-e", "0"], env);
    await expect(shardsOf()).rejects.toThrow(`Subprocess covered no repository source: ${env.NODE_V8_COVERAGE!.split("/").at(-1)}`);
  });

  it("errors on a bundle that maps to authored files but was never registered", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "rendro-subprocess-bundle-"));
    directories.push(scratch);
    await build({ entryPoints: [bundled], bundle: true, platform: "node", format: "esm", outfile: join(scratch, "rogue.mjs"), sourcemap: "inline", sourcesContent: true });
    run([join(scratch, "rogue.mjs"), "--dry-run"]);
    await expect(shardsOf()).rejects.toThrow(/Unregistered subprocess bundle: file:\/\/.*rogue\.mjs/);
  }, 60_000);

  it("errors on an authored script without a source map or a registered bundle without one", async () => {
    const included = new Set(await sourceManifest(root));
    const url = pathToFileURL(resolve("shared/storage-path.ts")).href;
    const dump = (scriptUrl: string): NodeDump => ({ result: [{ scriptId: "1", url: scriptUrl, functions: [] }] });
    await expect(convertDumps(root, [dump(url)], included, new Map())).rejects.toThrow(`Missing source map: ${url}`);
    const bundle = pathToFileURL(join(tmpdir(), "unmapped-bundle.mjs")).href;
    await expect(convertDumps(root, [dump(bundle)], included, new Map([[bundle, "export {};"]]))).rejects.toThrow(`Missing source map: ${bundle}`);
    // Dependencies, Node internals and non-file scripts are skipped, not errors.
    const dependency = pathToFileURL(resolve("node_modules/zod/package.json")).href;
    expect(await convertDumps(root, [{ result: [dump(dependency).result[0], dump("node:internal/x").result[0]] }], included, new Map())).toEqual({});
  });

  it("errors when a script's recorded source is stale or its tsx output cannot be reproduced", async () => {
    const included = new Set(await sourceManifest(root));
    const path = resolve("shared/storage-path.ts");
    const url = pathToFileURL(path).href;
    // Capture the child's real source-map-cache entry.
    runTs('await import("./shared/storage-path.ts");');
    const receipt = readdirSync(join(output, "raw"))[0];
    const dumps = readdirSync(join(output, "raw", receipt)).map(name => JSON.parse(readFileSync(join(output, "raw", receipt, name), "utf8")) as NodeDump);
    const entry = dumps.map(dump => dump["source-map-cache"]?.[url]).find(Boolean)!;
    const script = dumps.flatMap(dump => dump.result).find(candidate => candidate.url === url)!;

    const stale = structuredClone(entry);
    stale.data!.sourcesContent = ["export const stale = true;\n"];
    await expect(convertDumps(root, [{ result: [script], "source-map-cache": { [url]: stale } }], included, new Map())).rejects.toThrow("Stale source: shared/storage-path.ts");

    const drifted = structuredClone(entry);
    drifted.lineLengths = [1];
    await expect(reproduceTsxModule(readFileSync(path, "utf8"), path, drifted as never)).rejects.toThrow(`Cannot reproduce the tsx transform of ${path}`);
    await expect(reproduceTsxModule(readFileSync(path, "utf8"), path, entry as never)).resolves.toMatchObject({ code: expect.stringContaining("isCanonicalStorageKey"), inserted: [] });
  });
});

describe("alignment", () => {
  async function pair() {
    const { canonical } = await canonicalCoverage(resolve("shared/storage-path.ts"));
    return { canonical, actual: structuredClone(canonical) };
  }

  it("falls back to a start-only identity when a re-print moves a statement's end", async () => {
    const { canonical, actual } = await pair();
    const id = Object.keys(actual.statementMap)[0];
    actual.statementMap[id].end = { line: 9999, column: 7 };
    actual.s[id] = 5;
    expect(alignCoverage(actual, canonical, reprintedIdentities).s[id]).toBe(5);
    expect(() => alignCoverage(actual, canonical)).toThrow(`Ambiguous coverage transform: ${actual.path} s:${id}`);
  });

  it("matches functions by body span when the declaration span moves", async () => {
    const { canonical, actual } = await pair();
    const id = Object.keys(actual.fnMap)[0];
    actual.fnMap[id].decl = { start: { line: 99, column: 0 }, end: { line: 99, column: 1 } };
    actual.f[id] = 3;
    expect(alignCoverage(actual, canonical, reprintedIdentities).f[id]).toBe(3);
  });

  it("rejects a report that lacks a canonical function", async () => {
    const { canonical, actual } = await pair();
    const id = Object.keys(actual.fnMap)[0];
    delete actual.fnMap[id]; delete actual.f[id];
    expect(() => alignCoverage(actual, canonical, reprintedIdentities)).toThrow(`Missing coverage identities: ${actual.path} f`);
  });
});
