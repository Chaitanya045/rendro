import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { performance } from "node:perf_hooks";
import { afterEach, describe, expect, it, vi } from "vitest";
import { artifacts, checksumManifest, runComrakWasm, verifyCommitted } from "../scripts/comrak-wasm/build";
import { hostileInputs, runHostileBenchmark } from "../scripts/comrak-wasm/benchmark";

const directories: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const fixture = {
  wasm: "wasm-bytes-v1",
  js: "// comrak_engine.js\n",
  dts: "// comrak_engine.d.ts\n",
  bgdts: "// comrak_engine_bg.wasm.d.ts\n",
};

/** A project root with committed artifacts, a valid checksum, and an empty crate directory. */
function workspace() {
  const root = mkdtempSync(join(tmpdir(), "rendro-comrak-"));
  directories.push(root);
  const dir = join(root, "src/ingest/comrak-engine");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "comrak_engine_bg.wasm"), fixture.wasm);
  writeFileSync(join(dir, "comrak_engine.js"), fixture.js);
  writeFileSync(join(dir, "comrak_engine.d.ts"), fixture.dts);
  writeFileSync(join(dir, "comrak_engine_bg.wasm.d.ts"), fixture.bgdts);
  writeFileSync(join(dir, "comrak_engine.sha256"), checksumManifest(root));
  mkdirSync(join(root, "wasm/comrak-engine"), { recursive: true });
  return root;
}

const cargo = `#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
if (process.env.FAKE_CARGO_FAIL) process.exit(1);
const dir = join(process.env.CARGO_TARGET_DIR, "wasm32-unknown-unknown/release");
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, "comrak_engine.wasm"), process.env.FAKE_WASM ?? "");
`;

const wasmBindgen = `#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
const out = args[args.indexOf("--out-dir") + 1];
mkdirSync(out, { recursive: true });
writeFileSync(join(out, "comrak_engine_bg.wasm"), readFileSync(args.at(-1)));
writeFileSync(join(out, "comrak_engine.js"), process.env.FAKE_JS ?? "");
writeFileSync(join(out, "comrak_engine.d.ts"), process.env.FAKE_DTS ?? "");
writeFileSync(join(out, "comrak_engine_bg.wasm.d.ts"), process.env.FAKE_BGDTS ?? "");
`;

/** Put a fake cargo/wasm-bindgen on PATH so the rebuild runs without a Rust toolchain. */
function toolchain(root: string) {
  const bin = join(root, "bin");
  mkdirSync(bin);
  for (const [name, source] of [["cargo", cargo], ["wasm-bindgen", wasmBindgen]] as const) {
    writeFileSync(join(bin, name), source);
    chmodSync(join(bin, name), 0o755);
  }
  vi.stubEnv("PATH", `${bin}${delimiter}${process.env.PATH}`);
  vi.stubEnv("FAKE_WASM", fixture.wasm);
  vi.stubEnv("FAKE_JS", fixture.js);
  vi.stubEnv("FAKE_DTS", fixture.dts);
  vi.stubEnv("FAKE_BGDTS", fixture.bgdts);
  return bin;
}

describe("comrak wasm artifacts", () => {
  it("verifies the committed checksum and fails closed on drift", () => {
    const root = workspace();
    const log = vi.fn();
    verifyCommitted(root, log);
    runComrakWasm(root, [], log);
    expect(log).toHaveBeenCalledWith("Comrak WebAssembly checksum verified.");

    writeFileSync(join(root, "src/ingest/comrak-engine/comrak_engine.sha256"), "deadbeef  comrak_engine_bg.wasm\n");
    expect(() => verifyCommitted(root, log)).toThrow(/does not match/);
  });

  it("rebuilds from a clean target directory and requires byte-identical output", () => {
    const root = workspace();
    const bin = toolchain(root);
    vi.stubEnv("WASM_BINDGEN", join(bin, "wasm-bindgen"));
    const log = vi.fn();
    runComrakWasm(root, ["--rebuild"], log);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/byte-identical \(4 artifacts, sha256 [0-9a-f]{64}\)/));
  });

  it("names every artifact a rebuild failed to reproduce", () => {
    const root = workspace();
    toolchain(root);
    vi.stubEnv("FAKE_WASM", `${fixture.wasm}-drifted`);
    const log = vi.fn();
    expect(() => runComrakWasm(root, ["--rebuild"], log)).toThrow(/not reproducible[\s\S]*comrak_engine_bg\.wasm: committed [0-9a-f]{64} != rebuilt [0-9a-f]{64}/);
  });

  it("writes the rebuilt artifacts and checksum, and cleans up when cargo fails", () => {
    const root = workspace();
    toolchain(root);
    const log = vi.fn();
    runComrakWasm(root, ["--write"], log);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/Wrote 4 artifacts/));
    const dir = join(root, "src/ingest/comrak-engine");
    expect(readFileSync(join(dir, "comrak_engine.js"), "utf8")).toBe(fixture.js);
    expect(readFileSync(join(dir, "comrak_engine.sha256"), "utf8")).toBe(checksumManifest(root));

    const failing = workspace();
    toolchain(failing);
    vi.stubEnv("FAKE_CARGO_FAIL", "1");
    expect(() => runComrakWasm(failing, ["--rebuild"], log)).toThrow();
    expect(artifacts).toHaveLength(4);
  });

  it("verifies through the CLI entry against the working directory", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await import("../scripts/verify-comrak-wasm");
      expect(log).toHaveBeenCalledWith("Comrak WebAssembly checksum verified.");
    } finally {
      log.mockRestore();
    }
  });
});

// A busy wait makes the relative timings deterministic instead of depending on
// how long a real render happens to take under load.
const render = (markdown: string) => {
  const end = performance.now() + Number(markdown);
  while (performance.now() < end) { /* spin */ }
  return "";
};

describe("hostile-input benchmark", () => {
  it("covers the 26 pathological 1 MiB inputs from the technical docs", () => {
    expect(hostileInputs).toHaveLength(26);
    expect(hostileInputs[0].name).toBe("nested-brackets");
    expect(hostileInputs.map(input => input.name)).toContain("table-150k-rows");
    expect(hostileInputs.every(input => input.source.length > 0 && input.name.length > 0)).toBe(true);
  });

  it("reports each input and the slowest one", () => {
    const log = vi.fn();
    const report = runHostileBenchmark(render, [{ name: "slow", source: "5" }, { name: "fast", source: "0" }], log);
    expect(report.worst.name).toBe("slow");
    expect(report.inputs).toBe(2);
    expect(log).toHaveBeenCalledTimes(4);
    expect(log.mock.calls[0][0]).toBe("input                          KiB    output KiB   ms");
    expect(log.mock.calls.at(-1)?.[0]).toMatch(/2 inputs: \d+\.\d MiB\/s total, slowest slow at \d+ ms$/);
  });

  it("fails when an input exceeds the Worker CPU budget", () => {
    const log = vi.fn();
    expect(() => runHostileBenchmark(render, [{ name: "runaway", source: "0" }], log, -1)).toThrow("runaway took 0 ms, over the -1 ms Worker CPU budget");
  });

  it("runs the committed wasm through the CLI entry", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await import("../scripts/benchmark-hostile-input");
      expect(log).toHaveBeenCalledWith(expect.stringMatching(/26 inputs: \d+\.\d MiB\/s total, slowest \S+ at \d+ ms$/));
    } finally {
      log.mockRestore();
    }
  }, 60_000);
});
