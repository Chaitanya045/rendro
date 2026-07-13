/**
 * Builds the lazy-tree UI widget as a standalone IIFE.
 *
 * Run: tsx scripts/build-lazy-tree.ts
 */
import * as esbuild from "esbuild";

await esbuild.build({
  entryPoints: ["src/lazy-tree/lazy-tree.ts"],
  bundle: true,
  minify: false,
  format: "iife",
  outfile: "public/lazy-tree.js",
  platform: "browser",
});

await esbuild.stop();
console.log("Built public/lazy-tree.js");
