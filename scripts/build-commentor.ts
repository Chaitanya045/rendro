/**
 * Builds the commentor widget. The widget reads its configuration from
 * window.COMMENTOR, which the document routes inject before this script.
 *
 * Run: tsx scripts/build-commentor.ts
 */
import * as esbuild from "esbuild";
import { writeFileSync } from "node:fs";

const result = await esbuild.build({
  entryPoints: ["src/commentor/commentor.ts"],
  bundle: true,
  minify: true,
  format: "iife",
  globalName: "Commentor",
  outfile: "public/commentor.js",
  platform: "browser",
  write: false,
});

const code = result.outputFiles![0]!.text;
await esbuild.stop();

// Wrap so the IIFE's global name stays scoped to this script.
const wrapped = `
// Auto-injected by Rendro — do not edit manually.
(function() {
  ${code}
})();
`;

writeFileSync("public/commentor.js", wrapped);
console.log("Built public/commentor.js");
