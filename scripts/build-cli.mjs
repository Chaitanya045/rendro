import { execSync } from "node:child_process";
import { cpSync, rmSync, writeFileSync, readFileSync, chmodSync } from "node:fs";

cpSync("cli/src/index.ts", "cli/src/index.ts.bak");
const src = readFileSync("cli/src/index.ts", "utf-8");
writeFileSync("cli/src/_index.ts", src.replace(/^#!.*\n/, ""));

execSync("npx esbuild cli/src/_index.ts --bundle --platform=node --target=node22 --format=esm --outfile=bin/rendro.mjs --banner:js='#!/usr/bin/env node'", { stdio: "inherit" });

cpSync("cli/src/index.ts.bak", "cli/src/index.ts");
rmSync("cli/src/_index.ts");
rmSync("cli/src/index.ts.bak");
chmodSync("bin/rendro.mjs", 0o755);
console.log("CLI built: bin/rendro.mjs");
