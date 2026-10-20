/**
 * Builds the repository shell's real-user monitoring bundle (#282) as a standalone IIFE.
 * Minified: it carries web-vitals and loads on every repository view.
 *
 * Run: tsx scripts/build-rum.ts
 */
import * as esbuild from "esbuild";

await esbuild.build({
  entryPoints: ["src/rum/client.ts"],
  bundle: true,
  minify: true,
  format: "iife",
  outfile: "public/rum.js",
  platform: "browser",
  // web-vitals' own headers are not legal comments, so name its licence here.
  banner: { js: "/*! web-vitals 6.2.3 | Apache-2.0 | https://github.com/GoogleChrome/web-vitals */" },
});

await esbuild.stop();
console.log("Built public/rum.js");
