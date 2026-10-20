import { execFile } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { subprocessEnv } from "./helpers/subprocess-coverage";

const fixtures: string[] = [];
afterEach(() => { for (const directory of fixtures.splice(0)) rmSync(directory, { recursive: true, force: true }); });

/** A private working directory holding copies of the sources the builds read; builds write only here. */
function workspace(...trees: string[]) {
  const directory = mkdtempSync(join(tmpdir(), "rendro-build-"));
  fixtures.push(directory);
  for (const tree of trees) cpSync(resolve(tree), join(directory, tree), { recursive: true });
  for (const file of ["tsconfig.json", "package.json"]) cpSync(resolve(file), join(directory, file));
  mkdirSync(join(directory, "public"));
  symlinkSync(resolve("node_modules"), join(directory, "node_modules"));
  return directory;
}

async function run(cwd: string, script: string, args: string[] = []) {
  const output = await promisify(execFile)(process.execPath, ["--import", "tsx", resolve("scripts", script), ...args], { cwd, env: subprocessEnv(), timeout: 60_000 })
    .then(result => ({ ...result, code: 0 }), (error: { code: number; stdout: string; stderr: string }) => error);
  return output;
}

const assets = [
  ["build-commentor.ts", "commentor.js"],
  ["build-commentor-parent.ts", "commentor-parent.js"],
  ["build-lazy-tree.ts", "lazy-tree.js"],
  ["build-rum.ts", "rum.js"],
  ["build-private-viewer.ts", "private-viewer.js"],
] as const;

describe("asset build scripts", () => {
  it.each(assets)("%s writes only %s into its working directory, deterministically", async (script, output) => {
    const first = workspace("src", "shared", "convex");
    const result = await run(first, script);
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(new RegExp(`^Built public/${output.replace(".", "\\.")}\\n$`));
    expect(readdirSync(join(first, "public"))).toEqual([output]);
    const bytes = readFileSync(join(first, "public", output));
    expect(bytes.length).toBeGreaterThan(1000);

    const second = workspace("src", "shared", "convex");
    expect((await run(second, script)).code).toBe(0);
    expect(readFileSync(join(second, "public", output)).equals(bytes)).toBe(true);
  }, 90_000);

  it("wraps the commentor in a scoped function so its global name does not leak", async () => {
    const directory = workspace("src", "shared", "convex");
    await run(directory, "build-commentor.ts");
    const code = readFileSync(join(directory, "public/commentor.js"), "utf8");
    expect(code.startsWith("\n// Auto-injected by Rendro — do not edit manually.\n(function() {")).toBe(true);
    expect(code.trimEnd().endsWith("})();")).toBe(true);
  }, 60_000);
});
