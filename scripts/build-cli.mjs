import { build } from "esbuild";
import { chmod } from "node:fs/promises";

// Build directly from the source without rewriting it or downloading a tool.
// npm pack/publish runs this too, so a stale ignored bundle cannot be shipped.
await build({
  entryPoints: ["cli/src/index.ts"],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  outfile: "bin/rendro.mjs",
});
await chmod("bin/rendro.mjs", 0o755);
console.log("CLI built: bin/rendro.mjs");
