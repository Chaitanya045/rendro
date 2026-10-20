import * as esbuild from "esbuild";
import { writeFileSync } from "node:fs";

// --metafile=<path> writes esbuild's input/output graph (see build-commentor.ts).
const metafile = process.argv.find(arg => arg.startsWith("--metafile="))?.slice("--metafile=".length);

const result = await esbuild.build({
  entryPoints: ["src/commentor/parent-entry.ts"],
  bundle: true,
  minify: true,
  format: "iife",
  target: "es2022",
  outfile: "public/commentor-parent.js",
  platform: "browser",
  metafile: metafile !== undefined,
});
await esbuild.stop();
if (metafile) writeFileSync(metafile, JSON.stringify(result.metafile));
console.log("Built public/commentor-parent.js");
