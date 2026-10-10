import * as esbuild from "esbuild";
import { managementPagesSource } from "./management-pages-source";
await esbuild.build({ stdin: { contents: await managementPagesSource(), loader: "js" }, minify: true, target: "es2022", outfile: "public/management-pages.js", platform: "browser" });
await esbuild.stop();
console.log("Built public/management-pages.js");
