/**
 * Builds the commentor widget. The CONVEX_URL is injected at build time
 * or read from a global config on the page.
 *
 * Run: tsx scripts/build-commentor.ts
 */
import * as esbuild from "esbuild";
import { readFileSync, writeFileSync } from "node:fs";

const result = await esbuild.build({
  entryPoints: ["src/commentor/commentor.ts"],
  bundle: true,
  minify: false,
  format: "iife",
  globalName: "Commentor",
  outfile: "public/commentor.js",
  platform: "browser",
  write: false,
});

const code = result.outputFiles![0]!.text;
await esbuild.stop();

// Wrap so CONVEX_URL can be injected at page render time
const wrapped = `
// Auto-injected by Docsync — do not edit manually.
(function() {
  var CONVEX_URL = window.__COMMENTOR_URL__ || "";
  if (!CONVEX_URL) return;
  ${code}
})();
`;

writeFileSync("public/commentor.js", wrapped);
console.log("Built public/commentor.js");
