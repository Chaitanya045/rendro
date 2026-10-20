/**
 * Builds the commentor widget. The widget reads its configuration from
 * window.COMMENTOR, which the document routes inject before this script.
 *
 * Run: tsx scripts/build-commentor.ts [--metafile=<path>]
 * --metafile writes esbuild's input/output graph (tests assert the frame
 * bundles no convex/ module, #315).
 */
import * as esbuild from "esbuild";
import { writeFileSync } from "node:fs";

const metafile = process.argv.find(arg => arg.startsWith("--metafile="))?.slice("--metafile=".length);

const result = await esbuild.build({
  entryPoints: ["src/commentor/commentor.ts"],
  bundle: true,
  minify: true,
  format: "iife",
  globalName: "Commentor",
  outfile: "public/commentor.js",
  platform: "browser",
  write: false,
  metafile: metafile !== undefined,
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
if (metafile) writeFileSync(metafile, JSON.stringify(result.metafile));
console.log("Built public/commentor.js");
