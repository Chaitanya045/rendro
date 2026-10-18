import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

/*
 * The ingest Worker renders Markdown with a WebAssembly build of the upstream
 * comrak crate that we produce ourselves (wasm/comrak-engine), rather than a
 * third-party npm package. The compiled module, its wasm-bindgen glue and a
 * SHA-256 checksum file are committed under src/ingest/comrak-engine so that
 * `pnpm verify` can check the artifact without a Rust toolchain.
 *
 *   (default)  verify the committed artifacts against the checksum file
 *   --rebuild  rebuild from the pinned crate and require byte-identical output
 *   --write    rebuild and write the artifacts + checksum file (maintainers)
 *
 * The rebuild needs the pinned Rust toolchain and a matching wasm-bindgen-cli,
 * so it only runs in the `comrak-engine` CI job and on maintainer machines;
 * `pnpm verify` uses the default checksum check.
 */

// Order is the checksum file's line order; the wasm module is the artifact that
// matters and the rest are its generated glue.
export const artifacts = ["comrak_engine_bg.wasm", "comrak_engine.js", "comrak_engine.d.ts", "comrak_engine_bg.wasm.d.ts"];

export type Log = (message: string) => void;

const crateDir = (root: string) => join(root, "wasm/comrak-engine");
const artifactsDir = (root: string) => join(root, "src/ingest/comrak-engine");

/*
 * A Rust->WebAssembly build is only reproducible if no build-machine path is
 * embedded in the artifact: rustc records the absolute source path of every
 * crate (including registry dependencies) in panic-location strings, so the
 * same source built under a different checkout or CARGO_HOME yields different
 * bytes. Remap every path that can appear to a fixed prefix. Longest prefix
 * first, so a nested path is rewritten by the most specific rule.
 */
export function reproducibleRustflags(root: string, target: string, env: NodeJS.ProcessEnv): string {
  const home = env.HOME ?? homedir();
  const remaps: ReadonlyArray<readonly [string, string]> = [
    [crateDir(root), "/build"],
    [target, "/target"],
    [env.CARGO_HOME ?? join(home, ".cargo"), "/cargo"],
    [env.RUSTUP_HOME ?? join(home, ".rustup"), "/rustup"],
  ];
  return [...remaps]
    .sort(([a], [b]) => b.length - a.length)
    .map(([from, to]) => `--remap-path-prefix=${from}=${to}`)
    .join(" ");
}

const sha256 = (data: Buffer) => createHash("sha256").update(data).digest("hex");

/** Index of the first byte that differs, or -1 if one buffer is a copy of the other. */
export function firstDifference(a: Uint8Array, b: Uint8Array): number {
  const limit = Math.min(a.length, b.length);
  for (let i = 0; i < limit; i++) if (a[i] !== b[i]) return i;
  return a.length === b.length ? -1 : limit;
}

export function checksumManifest(root: string): string {
  return artifacts.map(name => `${sha256(readFileSync(join(artifactsDir(root), name)))}  ${name}`).join("\n") + "\n";
}

/** Rebuild from source in a clean target directory, so stale objects cannot mask a change. */
function rebuild(root: string): string {
  const target = mkdtempSync(join(tmpdir(), "comrak-engine-build-"));
  const out = join(target, "pkg");
  // wasm-bindgen is given paths relative to the target directory so its argv is
  // identical everywhere; the numbers below pin the inputs of the Rust build.
  const builtWasm = "wasm32-unknown-unknown/release/comrak_engine.wasm";
  try {
    execFileSync("cargo", ["build", "--release", "--target", "wasm32-unknown-unknown", "--locked"], {
      cwd: crateDir(root),
      env: {
        ...process.env,
        CARGO_TARGET_DIR: target,
        CARGO_INCREMENTAL: "0",
        SOURCE_DATE_EPOCH: "0",
        RUSTFLAGS: reproducibleRustflags(root, target, process.env),
      },
      stdio: "inherit",
    });
    execFileSync(
      process.env.WASM_BINDGEN ?? "wasm-bindgen",
      ["--target", "web", "--out-dir", "pkg", "--out-name", "comrak_engine", builtWasm],
      { cwd: target, env: { ...process.env, SOURCE_DATE_EPOCH: "0" }, stdio: "inherit" },
    );
    // Keep the built tree alive only long enough to copy what we need.
    return out;
  } catch (error) {
    rmSync(target, { recursive: true, force: true });
    throw error;
  }
}

export function verifyCommitted(root: string, log: Log): void {
  const file = join(artifactsDir(root), "comrak_engine.sha256");
  const expected = readFileSync(file, "utf8");
  const actual = checksumManifest(root);
  if (actual !== expected) {
    throw new Error(`Committed comrak WebAssembly does not match ${file}.\n--- expected ---\n${expected}--- actual ---\n${actual}`);
  }
  log("Comrak WebAssembly checksum verified.");
}

export function rebuildAndCompare(root: string, log: Log): void {
  const built = rebuild(root);
  try {
    const mismatches = artifacts.flatMap(name => {
      const committed = readFileSync(join(artifactsDir(root), name));
      const rebuilt = readFileSync(join(built, name));
      if (committed.equals(rebuilt)) return [];
      return [`  ${name}: committed ${sha256(committed)} != rebuilt ${sha256(rebuilt)} (first difference at byte ${firstDifference(committed, rebuilt)})`];
    });
    if (mismatches.length > 0) {
      throw new Error(`Rebuilding wasm/comrak-engine is not reproducible; these artifacts differ:\n${mismatches.join("\n")}`);
    }
    log(`Comrak WebAssembly rebuild is byte-identical (${artifacts.length} artifacts, sha256 ${sha256(readFileSync(join(artifactsDir(root), "comrak_engine_bg.wasm")))}).`);
  } finally {
    rmSync(built, { recursive: true, force: true });
  }
}

export function rebuildAndWrite(root: string, log: Log): void {
  const built = rebuild(root);
  try {
    for (const name of artifacts) cpSync(join(built, name), join(artifactsDir(root), name));
    writeFileSync(join(artifactsDir(root), "comrak_engine.sha256"), checksumManifest(root));
    log(`Wrote ${artifacts.length} artifacts and ${join(artifactsDir(root), "comrak_engine.sha256")}.`);
  } finally {
    rmSync(built, { recursive: true, force: true });
  }
}

export function runComrakWasm(root: string, args: string[], log: Log = console.log): void {
  if (args.includes("--write")) rebuildAndWrite(root, log);
  else if (args.includes("--rebuild")) {
    verifyCommitted(root, log);
    rebuildAndCompare(root, log);
  } else verifyCommitted(root, log);
}
