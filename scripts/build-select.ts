import * as esbuild from "esbuild";
await esbuild.build({ entryPoints: ["src/ui/select-browser.ts"], bundle: true, minify: true, format: "iife", target: "es2022", outfile: "public/select.js", platform: "browser" });
await esbuild.stop();
console.log("Built public/select.js");
