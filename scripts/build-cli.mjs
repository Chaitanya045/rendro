import { execSync, writeFileSync, readFileSync, chmodSync, cpSync, rmSync } from "node:fs";

// Backup source
cpSync("cli/src/index.ts", "cli/src/index.ts.bak");

// Strip shebang, build
const src = readFileSync("cli/src/index.ts", "utf-8");
writeFileSync("cli/src/_index.ts", src.replace(/^#!.*\n/, ""));

execSync("npx esbuild cli/src/_index.ts --bundle --platform=node --target=node22 --format=esm --outfile=bin/rendro.mjs --banner:js='#!/usr/bin/env node'", { stdio: "inherit" });

// Restore and clean
cpSync("cli/src/index.ts.bak", "cli/src/index.ts");
rmSync("cli/src/_index.ts");
rmSync("cli/src/index.ts.bak");

chmodSync("bin/rendro.mjs", 0o755);
console.log("CLI built: bin/rendro.mjs");
