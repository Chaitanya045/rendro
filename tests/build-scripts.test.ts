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

  // The frame only receives errors the parent already serialized (#315). The parent, which talks to Convex,
  // is the control: it must still bundle convex/values, so the same check would catch a regression.
  it("keeps every convex/ module out of the document frame's commentor.js, but not the parent's", async () => {
    const directory = workspace("src", "shared", "convex");
    const convexInputs = async (script: string, output: string) => {
      const metafile = join(directory, `${output}.meta.json`);
      expect((await run(directory, script, [`--metafile=${metafile}`])).code).toBe(0);
      const inputs = Object.keys((JSON.parse(readFileSync(metafile, "utf8")) as { inputs: Record<string, unknown> }).inputs);
      expect(inputs).toContain("src/commentor/error-mapping.ts");
      return { inputs: inputs.filter(input => /(^|\/)convex\//.test(input)), code: readFileSync(join(directory, "public", output), "utf8") };
    };
    const frame = await convexInputs("build-commentor.ts", "commentor.js");
    expect(frame.inputs).toEqual([]);
    expect(frame.code).not.toContain("ConvexError");
    const parent = await convexInputs("build-commentor-parent.ts", "commentor-parent.js");
    expect(parent.inputs).toContainEqual(expect.stringMatching(/node_modules\/convex\/dist\/esm\/values\/errors\.js$/));
    expect(parent.code).toContain("ConvexError");
  }, 90_000);
});
