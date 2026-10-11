import * as esbuild from "esbuild";
await esbuild.build({
  entryPoints: ["src/viewer/entry.ts"], bundle: true, minify: true,
  format: "iife", target: "es2022", outfile: "public/private-viewer.js", platform: "browser",
});
await esbuild.stop();
console.log("Built public/private-viewer.js");
