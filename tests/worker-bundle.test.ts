import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { budgetPath, measure, tolerance, type BundleBudget } from "../scripts/bundle-budget";
import { bundleWorker, forbiddenInBundle, forbiddenPackages, packageOf, workerBudgetKey, workerEntries } from "../scripts/worker-bundle";

describe("Worker bundles (#357)", () => {
  it.each([
    ["node_modules/zod/v4/index.js", "zod"],
    ["node_modules/.pnpm/zod@4.6.7/node_modules/zod/v4/classic/schemas.js", "zod"],
    ["node_modules/.pnpm/@pinojs+redact@0.4.0/node_modules/@pinojs/redact/index.js", "@pinojs/redact"],
    ["../node_modules/hono/dist/hono.js", "hono"],
    ["src/config.ts", null],
    ["shared/zod-free.ts", null],
  ])("names the package of %s", (input, expected) => {
    expect(packageOf(input)).toBe(expected);
  });

  it("flags only forbidden packages", () => {
    expect(forbiddenInBundle("src/worker.ts", ["hono", "parse5"])).toEqual([]);
    expect(forbiddenInBundle("src/worker.ts", ["hono", "zod"])).toEqual([`src/worker.ts bundles zod: ${forbiddenPackages.zod}.`]);
  });

  // Bundles the real entry points with esbuild: the regression guard for the Worker's cold start. A few seconds in total.
  it.each(workerEntries)("%s bundles no forbidden package", async (entry) => {
    const { packages, code } = await bundleWorker(process.cwd(), entry);
    expect(packages).not.toContain("zod");
    expect(forbiddenInBundle(entry, packages)).toEqual([]);
    expect(code.length).toBeGreaterThan(10_000);
  }, 60_000);

  it("keeps the serving Worker within its recorded size, and well under the 969 KB it weighed with zod", async () => {
    const { code } = await bundleWorker(process.cwd(), "src/worker.ts");
    const size = measure(code);
    const budget = (JSON.parse(readFileSync(budgetPath, "utf8")) as BundleBudget)[workerBudgetKey]!;
    expect(size.raw).toBeLessThanOrEqual(Math.floor(budget.raw * (1 + tolerance)));
    expect(size.brotli).toBeLessThanOrEqual(Math.floor(budget.brotli * (1 + tolerance)));
    expect(size.raw).toBeLessThan(600_000);
  }, 60_000);
});
