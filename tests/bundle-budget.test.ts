import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliCompressSync, constants } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { budgetPath, checkBudget, measure, runBundleBudget, servedBundles, tolerance, type BundleBudget } from "../scripts/bundle-budget";
import { versionedBundles } from "../src/routes/versioned-bundles";

const fixtures: string[] = [];
afterEach(() => { for (const directory of fixtures.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "rendro-bundle-budget-"));
  fixtures.push(root);
  for (const directory of ["public/styles", "public/fonts", "scripts", "src/ingest/comrak-engine"]) mkdirSync(join(root, directory), { recursive: true });
  for (const route of Object.keys(versionedBundles)) writeFileSync(join(root, `public${route}`), `console.log(${JSON.stringify(route)});\n`);
  writeFileSync(join(root, "public/styles/repo-doc.0123456789.css"), "body { color: red; }\n");
  writeFileSync(join(root, "public/styles/notes.txt"), "not served as a stylesheet\n");
  writeFileSync(join(root, "public/fonts/inter-latin.abcdef0123.woff2"), "wOF2");
  writeFileSync(join(root, "public/fonts/LICENSE-Inter-OFL-1.1.txt"), "licence");
  writeFileSync(join(root, "src/ingest/comrak-engine/comrak_engine_bg.wasm"), "\0asm");
  return root;
}

const size = (raw: number, brotli: number) => ({ raw, brotli });
// The fixture serves the versioned bundles, one stylesheet, one font subset and the WASM.
const served = Object.keys(versionedBundles).length + 3;

describe("bundle budget check", () => {
  it("passes sizes at the budget and growth within the tolerance", () => {
    const budget = { "public/a.js": size(10_000, 1_000) };
    expect(checkBudget(budget, { "public/a.js": size(10_000, 1_000) })).toEqual({ failures: [], hints: [] });
    expect(checkBudget(budget, { "public/a.js": size(10_000 * (1 + tolerance), 1_010) })).toEqual({ failures: [], hints: [] });
  });

  it("fails growth beyond the tolerance, naming the bundle, both sizes, the delta and the way to record it", () => {
    const { failures, hints } = checkBudget({ "public/a.js": size(10_000, 1_000) }, { "public/a.js": size(10_000, 1_011) });
    expect(hints).toEqual([]);
    expect(failures).toEqual([
      "public/a.js grew beyond its budget: Brotli 1,000 B → 1,011 B (+11 B, +1.1%). If the weight is intended, run pnpm record:budget and commit scripts/bundle-budget.json with the change so it is reviewed.",
    ]);
  });

  it("checks raw bytes separately from Brotli bytes", () => {
    const { failures } = checkBudget({ "public/a.js": size(10_000, 1_000) }, { "public/a.js": size(12_000, 1_000) });
    expect(failures).toEqual([expect.stringContaining("public/a.js grew beyond its budget: raw 10,000 B → 12,000 B (+2,000 B, +20.0%)")]);
  });

  it("fails a bundle over budget even when another bundle shrank enough to compensate", () => {
    const budget = { "public/a.js": size(100, 100), "public/b.js": size(100, 100) };
    const { failures, hints } = checkBudget(budget, { "public/a.js": size(150, 150), "public/b.js": size(10, 10) });
    expect(failures).toHaveLength(2);
    expect(hints).toHaveLength(2);
  });

  it("always lets a bundle shrink and hints to lower its budget", () => {
    const { failures, hints } = checkBudget({ "public/a.js": size(10_000, 1_000) }, { "public/a.js": size(9_000, 900) });
    expect(failures).toEqual([]);
    expect(hints).toEqual([
      "public/a.js shrank: Brotli 1,000 B → 900 B (−100 B, −10.0%). Run pnpm record:budget to lower its budget.",
      "public/a.js shrank: raw 10,000 B → 9,000 B (−1,000 B, −10.0%). Run pnpm record:budget to lower its budget.",
    ]);
  });

  it("fails a served bundle without a budget entry", () => {
    expect(checkBudget({}, { "public/new.js": size(2_048, 512) }).failures).toEqual([
      "public/new.js has no budget entry (512 B Brotli, 2,048 B raw). Run pnpm record:budget to add it.",
    ]);
  });

  it("fails a budget entry for a bundle that is no longer served", () => {
    expect(checkBudget({ "public/old.js": size(1, 1) }, {}).failures).toEqual([
      "public/old.js has a budget but is no longer served. Run pnpm record:budget to drop its entry.",
    ]);
  });
});

describe("served bundles", () => {
  it("lists every versioned bundle, stylesheet, font subset and the comrak WASM under hash-free keys", () => {
    const root = fixture();
    expect([...servedBundles(root)]).toEqual([
      ...Object.keys(versionedBundles).map(route => [`public${route}`, `public${route}`]),
      ["public/styles/repo-doc.css", "public/styles/repo-doc.0123456789.css"],
      ["public/fonts/inter-latin.woff2", "public/fonts/inter-latin.abcdef0123.woff2"],
      ["src/ingest/comrak-engine/comrak_engine_bg.wasm", "src/ingest/comrak-engine/comrak_engine_bg.wasm"],
    ]);
  });

  it("measures raw bytes and Brotli quality 11 bytes", () => {
    const data = new TextEncoder().encode("const repeated = 'abc';\n".repeat(200));
    const { raw, brotli } = measure(data);
    expect(raw).toBe(data.length);
    expect(brotli).toBe(brotliCompressSync(data, { params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: data.length } }).length);
    expect(brotli).toBeLessThan(raw / 10);
  });

  it("covers every bundle the repository serves", () => {
    const budget = JSON.parse(readFileSync(budgetPath, "utf8")) as BundleBudget;
    const keys = Object.keys(budget);
    for (const route of Object.keys(versionedBundles)) expect(keys).toContain(`public${route}`);
    expect(keys).toEqual(expect.arrayContaining(["public/styles/repo-doc.css", "public/styles/viewer-base.css", "public/fonts/inter-latin.woff2", "src/ingest/comrak-engine/comrak_engine_bg.wasm"]));
    expect(keys).toEqual([...keys].sort());
  });
});

describe("bundle budget CLI", () => {
  it("records, verifies, rejects growth until it is recorded, and hints after a shrink", () => {
    const root = fixture();
    const log = vi.fn();
    expect(runBundleBudget(root, [], log)).toBe(1);
    expect(log).toHaveBeenLastCalledWith(expect.stringContaining("public/lazy-tree.js has no budget entry"));

    expect(runBundleBudget(root, ["--record"], log)).toBe(0);
    expect(log).toHaveBeenLastCalledWith(`Recorded the budget of ${served} bundles in scripts/bundle-budget.json.`);
    const recorded = readFileSync(join(root, budgetPath), "utf8");
    expect(recorded.endsWith("}\n")).toBe(true);
    const keys = Object.keys(JSON.parse(recorded) as BundleBudget);
    expect(keys).toEqual([...keys].sort());
    expect(runBundleBudget(root, [], log)).toBe(0);
    expect(log).toHaveBeenLastCalledWith(`Bundle budget verified (${served} bundles, 1% tolerance).`);

    writeFileSync(join(root, "public/lazy-tree.js"), "console.log('a much larger lazy tree than before');\n".repeat(20));
    expect(runBundleBudget(root, [], log)).toBe(1);
    expect(log).toHaveBeenLastCalledWith(expect.stringMatching(/^public\/lazy-tree\.js grew beyond its budget: Brotli \d+ B → \d+ B \(\+\d+ B, \+[\d.]+%\)\. If the weight is intended, run pnpm record:budget/));

    expect(runBundleBudget(root, ["--record"], log)).toBe(0);
    writeFileSync(join(root, "public/lazy-tree.js"), "1\n");
    expect(runBundleBudget(root, [], log)).toBe(0);
    expect(log).toHaveBeenLastCalledWith(expect.stringMatching(/^public\/lazy-tree\.js shrank: Brotli .*\nBundle budget verified/s));
  });

  it("reports grown bundles together with the shrink hints", () => {
    const root = fixture();
    const log = vi.fn();
    runBundleBudget(root, ["--record"], log);
    writeFileSync(join(root, "public/rum.js"), "x".repeat(4_000));
    writeFileSync(join(root, "public/lazy-tree.js"), "1\n");
    expect(runBundleBudget(root, [], log)).toBe(1);
    expect(log).toHaveBeenLastCalledWith(expect.stringMatching(/^public\/rum\.js grew beyond its budget.*\npublic\/lazy-tree\.js shrank/s));
  });

  it("asks for a build when a bundle is missing, without writing a budget", () => {
    const root = fixture();
    rmSync(join(root, "public/commentor.js"));
    const log = vi.fn();
    expect(runBundleBudget(root, ["--record"], log)).toBe(1);
    expect(log).toHaveBeenLastCalledWith("public/commentor.js is missing. Run pnpm build:assets first.");
    expect(() => readFileSync(join(root, budgetPath))).toThrow();
  });
});
