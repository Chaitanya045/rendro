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

// Wrap so the widget can boot from window.COMMENTOR. If a legacy
// __COMMENTOR_URL__ override exists, use it only to fill a missing config URL.
const wrapped = `
// Auto-injected by Rendro — do not edit manually.
(function() {
  if (window.__COMMENTOR_URL__ && window.COMMENTOR && !window.COMMENTOR.convexUrl) {
    window.COMMENTOR.convexUrl = window.__COMMENTOR_URL__;
  }
  ${code}
})();
`;

writeFileSync("public/commentor.js", wrapped);
console.log("Built public/commentor.js");
