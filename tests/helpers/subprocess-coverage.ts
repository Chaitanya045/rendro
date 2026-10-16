import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { expect } from "vitest";

/** Set by `pnpm coverage`; unset in plain runs, where subprocesses run uninstrumented. */
export const SUBPROCESS_COVERAGE_DIR = "RENDRO_SUBPROCESS_COVERAGE_DIR";

export const subprocessRawDirectory = (directory: string) => join(directory, "raw");
export const subprocessBundleRegistry = (directory: string) => join(directory, "bundles");

function suiteName() {
  const path = expect.getState().testPath;
  if (!path) throw new Error("Subprocess coverage needs a running Vitest test");
  return basename(path);
}

/**
 * Environment for one Node subprocess. Each call creates its own empty receipt
 * directory (`<suite>-<uuid>`) that Node fills with V8 dumps at exit; the merger
 * fails the run when a receipt stays empty. Without a collector it is a no-op.
 */
export function subprocessEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const directory = process.env[SUBPROCESS_COVERAGE_DIR];
  if (!directory) return env;
  const receipt = join(subprocessRawDirectory(resolve(directory)), `${suiteName()}-${randomUUID()}`);
  mkdirSync(receipt, { recursive: true });
  return { ...env, NODE_V8_COVERAGE: receipt };
}

/** Node arguments that make a long-lived child (a server stopped by SIGTERM) exit normally, so V8 writes its dump. */
export function subprocessArgs() {
  return process.env[SUBPROCESS_COVERAGE_DIR] ? ["--import", resolve("tests/helpers/exit-on-sigterm.mjs")] : [];
}

/**
 * Build the CLI bundle exactly like scripts/build-cli.mjs. While collecting, the
 * test build keeps unused branches and inline source maps, and registers its code
 * so the merger can map the (deleted) scratch bundle back to cli/ sources.
 */
export async function buildCliBundle(outfile: string) {
  const directory = process.env[SUBPROCESS_COVERAGE_DIR];
  const collecting = Boolean(directory);
  const result = await build({
    entryPoints: ["cli/src/index.ts"], bundle: true, platform: "node", target: "node22", format: "esm", write: false, outfile,
    ...collecting && { sourcemap: "inline", sourcesContent: true, treeShaking: false },
  });
  const { text } = result.outputFiles![0];
  writeFileSync(outfile, text);
  if (directory) {
    const registry = subprocessBundleRegistry(resolve(directory));
    mkdirSync(registry, { recursive: true });
    writeFileSync(join(registry, `${randomUUID()}.json`), JSON.stringify({ url: pathToFileURL(realpathSync(outfile)).href, code: text }));
  }
}
