import { execSync, cpSync, rmSync, writeFileSync, readFileSync } from "node:fs";

// Backup source, strip shebang
cpSync("cli/src/index.ts", "cli/src/index.ts.bak");
const src = readFileSync("cli/src/index.ts", "utf-8");
writeFileSync("cli/src/_index.ts", src.replace(/^#!.*\n/, ""));

const platform = process.platform;
const arch = process.arch;
const ext = platform === "win32" ? ".exe" : "";
const target = `rendro-${platform}-${arch}${ext}`;

execSync(`bun build cli/src/_index.ts --compile --outfile bin/${target}`, { stdio: "inherit" });

// Restore and clean
cpSync("cli/src/index.ts.bak", "cli/src/index.ts");
rmSync("cli/src/_index.ts");
rmSync("cli/src/index.ts.bak");

console.log(`Built: bin/${target}`);
