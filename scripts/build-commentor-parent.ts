import * as esbuild from "esbuild";

await esbuild.build({
  entryPoints: ["src/commentor/parent-entry.ts"],
  bundle: true,
  minify: true,
  format: "iife",
  target: "es2022",
  outfile: "public/commentor-parent.js",
  platform: "browser",
});
await esbuild.stop();
console.log("Built public/commentor-parent.js");
