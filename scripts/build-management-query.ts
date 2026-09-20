import * as esbuild from "esbuild";

await esbuild.build({
  entryPoints: ["src/management-query/browser.ts"],
  bundle: true,
  minify: true,
  format: "iife",
  target: "es2022",
  outfile: "public/management-query.js",
  platform: "browser",
  legalComments: "eof",
});
await esbuild.stop();
console.log("Built public/management-query.js");
