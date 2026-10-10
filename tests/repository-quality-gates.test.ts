import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));
const scripts = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).scripts as Record<string, string>;
const assets = ["management-query.js", "select.js", "management-pages.js"];
const fixtures: string[] = [];

function assetFixture(): string {
  const directory = mkdtempSync(join(tmpdir(), "rendro-asset-gate-"));
  fixtures.push(directory);
  mkdirSync(join(directory, "public"));
  for (const name of assets) writeFileSync(join(directory, "public", name), "const version = 1;\n");
  execFileSync("git", ["init", "--quiet"], { cwd: directory });
  execFileSync("git", ["add", "public"], { cwd: directory });
  return directory;
}

function checkAssets(directory: string) {
  return spawnSync("sh", ["-c", scripts["verify:assets"]], { cwd: directory, encoding: "utf8" });
}

afterEach(() => { for (const directory of fixtures.splice(0)) rmSync(directory, { recursive: true, force: true }); });

describe("repository quality gates", () => {
  it("keeps newly added canonical and nested documentation visible to Git", () => {
    for (const path of ["docs/future-reference.md", "nested/docs/index.html"]) {
      const result = spawnSync("git", ["check-ignore", "--no-index", path], { cwd: root, encoding: "utf8" });
      expect(result.status, result.stdout + result.stderr).toBe(1);
    }
  });

  it("runs the asset drift gate after rebuilding in the quality workflow", () => {
    expect(scripts.verify).toContain("pnpm build:assets");
    expect(scripts.verify.indexOf("pnpm verify:assets")).toBeGreaterThan(scripts.verify.indexOf("pnpm build:assets"));
    expect(readFileSync(join(root, ".github/workflows/quality.yml"), "utf8")).toContain("run: pnpm verify");
  });

  it("rebuilds ignored browser assets in the canonical deployment command", () => {
    expect(scripts.deploy).toBe("pnpm build:assets && wrangler deploy --config wrangler.toml");
    expect(scripts["build:assets"]).toContain("tsx scripts/build-commentor-parent.ts");
    // `pnpm deploy` is a built-in workspace command, not this package script.
    expect(readFileSync(join(root, "docs/TECHNICAL.md"), "utf8")).toContain("pnpm run deploy --env development");
  });

  it("allows a clean generated build and unrelated working changes", () => {
    const directory = assetFixture();
    expect(checkAssets(directory).status).toBe(0);
    writeFileSync(join(directory, "unrelated.ts"), "const unrelated = true;\n");
    execFileSync("git", ["add", "unrelated.ts"], { cwd: directory });
    writeFileSync(join(directory, "unrelated.ts"), "const unrelated = false;\n");
    expect(checkAssets(directory).status).toBe(0);
  });

  it.each(assets)("rejects content-only rebuild drift in %s", (name) => {
    const directory = assetFixture();
    writeFileSync(join(directory, "public", name), "const version = 2;\n");
    expect(spawnSync("git", ["diff", "--check"], { cwd: directory }).status).toBe(0);
    const result = checkAssets(directory);
    expect(result.status, result.stderr).toBe(1);
    expect(result.stdout).toContain(name);
  });
});
