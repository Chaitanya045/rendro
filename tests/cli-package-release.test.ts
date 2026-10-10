import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { version } from "../package.json";

const execute = promisify(execFile);

it("packs a fresh dependency-free CLI and installs/runs it without build tools or install scripts", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "rendro-package-release-"));
  const sourceBefore = await readFile("cli/src/index.ts", "utf8");
  try {
    const packed = await execute("npm", ["pack", "--json", "--pack-destination", scratch], { cwd: resolve("."), timeout: 30000 });
    const packages = JSON.parse(packed.stdout.slice(packed.stdout.indexOf("[\n"))) as Array<{ filename: string; version: string; files: Array<{ path: string; mode: number }> }>;
    expect(packages[0].version).toBe(version);
    expect(packages[0].files.map(file => file.path).sort()).toEqual(["LICENSE", "README.md", "bin/rendro.mjs", "package.json"]);
    expect(packages[0].files.find(file => file.path === "bin/rendro.mjs")?.mode).toBe(0o755);
    expect(await readFile("cli/src/index.ts", "utf8")).toBe(sourceBefore);
    const install = join(scratch, "install");
    await execute("npm", ["install", "--prefix", install, "--offline", "--ignore-scripts", "--no-audit", "--no-fund", join(scratch, packages[0].filename)], { timeout: 30000 });
    const manifest = JSON.parse(await readFile(join(install, "node_modules/rendro/package.json"), "utf8"));
    expect(manifest.dependencies ?? {}).toEqual({});
    expect(manifest.engines.node).toBe(">=22");
    expect(manifest.scripts.prepack).toBe("node scripts/build-cli.mjs");
    const binary = join(install, "node_modules/.bin/rendro");
    expect((await execute(binary, ["--version"])).stdout.trim()).toBe(version);
    const help = (await execute(binary, ["--help"])).stdout;
    expect(help).toContain("--organization <id> --project <id>");
    expect(help).toContain("publication remove");
    const source = join(scratch, "docs");
    await execute(binary, ["init", "--source", source]);
    expect(await readFile(join(source, "index.html"), "utf8")).toContain("<h1>Welcome</h1>");
  } finally {
    await rm(scratch, { recursive: true });
  }
}, 60000);
