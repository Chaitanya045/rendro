/**
 * Builds the repository shell's behaviour (src/shell/shell-script.ts) into the minified, versioned bundle
 * `public/shell.js` (#359). Its source is plain ES5-style script text, so it is minified as a script
 * rather than bundled.
 *
 * Run: tsx scripts/build-shell.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import * as esbuild from "esbuild";
import { shellScript } from "../src/shell/shell-script";

const { code } = await esbuild.transform(shellScript, { minify: true, loader: "js" });
mkdirSync("public", { recursive: true });
writeFileSync("public/shell.js", code);

await esbuild.stop();
console.log("Built public/shell.js");
