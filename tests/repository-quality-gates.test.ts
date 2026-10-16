import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { AssetVersionLedger } from "../scripts/asset-version-ledger";
import { subprocessEnv } from "./helpers/subprocess-coverage";

const root = fileURLToPath(new URL("..", import.meta.url));
const scripts = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).scripts as Record<string, string>;
const assets = ["management-query.js", "select.js", "management-pages.js", "lazy-tree.js", "private-viewer.js", "commentor-parent.js"];
const fixtures: string[] = [];

function assetFixture(): string {
  const directory = mkdtempSync(join(tmpdir(), "rendro-asset-gate-"));
  fixtures.push(directory);
  mkdirSync(join(directory, "public"));
  mkdirSync(join(directory, "scripts"));
  // Symlinks resolve to the repository files, so the script under test is the real
  // one (and is attributed to scripts/ in subprocess coverage) while it only writes here.
  for (const name of ["verify-asset-versions.ts", "asset-version-ledger.ts"]) {
    symlinkSync(join(root, "scripts", name), join(directory, "scripts", name));
  }
  for (const name of ["src", "node_modules"]) symlinkSync(join(root, name), join(directory, name));
  const ledger = JSON.parse(readFileSync(join(root, "scripts/asset-versions.json"), "utf8")) as AssetVersionLedger;
  const content = "const version = 1;\n";
  for (const name of assets) {
    writeFileSync(join(directory, "public", name), content);
    for (const version of Object.keys(ledger[`public/${name}`])) {
      ledger[`public/${name}`][version] = createHash("sha256").update(content).digest("hex");
    }
  }
  writeFileSync(join(directory, "scripts/asset-versions.json"), JSON.stringify(ledger));
  execFileSync("git", ["init", "--quiet"], { cwd: directory });
  execFileSync("git", ["add", "public"], { cwd: directory });
  return directory;
}

function checkAssets(directory: string, base = "") {
  return spawnSync("sh", ["-c", scripts["verify:assets"]], { cwd: directory, encoding: "utf8", env: subprocessEnv({ ...process.env, ASSET_VERSION_BASE: base }) });
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

  it("schedules a credential-free stability workflow: constrained coverage twice with diffs, e2e without retries", () => {
    const workflow = readFileSync(join(root, ".github/workflows/stability.yml"), "utf8");
    expect(workflow).toMatch(/schedule:\s+- cron:/);
    expect(workflow).toMatch(/permissions:\s+contents: read/);
    expect(workflow).not.toMatch(/secrets\./);
    expect(workflow.match(/taskset -c 0,1 pnpm coverage \|\| status=\$\?/g)).toHaveLength(2);
    // The second pass and both comparisons run even when the first run failed.
    expect(workflow.match(/if: \$\{\{ !cancelled\(\) \}\}/g)).toHaveLength(3);
    expect(workflow).toContain("tests/helpers/diff-outcomes.ts");
    expect(workflow).toContain("tests/helpers/diff-coverage.ts");
    expect(workflow).toContain('E2E_RETRIES: "0"');
    expect(workflow).toContain("run: pnpm e2e --project=${{ matrix.project }}");
    // The overrides must reach their tools; a typo would silently restore the defaults.
    expect(readFileSync(join(root, "e2e/playwright.config.ts"), "utf8")).toContain("process.env.E2E_RETRIES");
    expect(readFileSync(join(root, "vitest.config.ts"), "utf8")).toContain("process.env.RENDRO_TEST_OUTCOMES");
    expect(workflow).toContain("RENDRO_TEST_OUTCOMES:");
  });

  it("runs each e2e engine as its own job behind one aggregate required check named e2e", () => {
    const quality = readFileSync(join(root, ".github/workflows/quality.yml"), "utf8");
    expect(quality).toContain("project: [chromium, firefox, webkit]");
    expect(quality).toContain("run: pnpm e2e --project=${{ matrix.project }}");
    expect(quality).toMatch(/\n {2}e2e:\n {4}runs-on: ubuntu-latest\n {4}needs: e2e-engine\n {4}if: \$\{\{ always\(\) \}\}/);
    expect(quality).toContain('test "$RESULT" = success');
    expect(quality).toContain("name: workerd-e2e-failures-${{ matrix.project }}");
  });

  it("rebuilds ignored browser assets in the canonical deployment command", () => {
    expect(scripts.deploy).toBe("pnpm build:assets && wrangler deploy --config wrangler.toml");
    expect(scripts["build:assets"]).toContain("tsx scripts/build-commentor-parent.ts");
    // `pnpm deploy` is a built-in workspace command, not this package script.
    expect(readFileSync(join(root, "docs/TECHNICAL.md"), "utf8")).toContain("pnpm run deploy --env development");
  });

  it("allows a clean generated build and unrelated working changes", () => {
    const directory = assetFixture();
    const result = checkAssets(directory);
    expect(result.status, result.stdout + result.stderr).toBe(0);
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
    expect(result.stdout + result.stderr).toContain(name);
  });

  it("rejects changed bundle bytes even after they are staged", () => {
    const directory = assetFixture();
    writeFileSync(join(directory, "public/management-query.js"), "const changed = true;\n");
    execFileSync("git", ["add", "public"], { cwd: directory });
    expect(spawnSync("git", ["diff", "--exit-code", "--", "public"], { cwd: directory }).status).toBe(0);
    const result = checkAssets(directory);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("without a version bump");
  });

  it("rejects rewriting the ledger to bless an existing version in CI", () => {
    const directory = assetFixture();
    execFileSync("git", ["add", "scripts/asset-versions.json"], { cwd: directory });
    execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "--quiet", "-m", "Baseline"], { cwd: directory });
    const manifest = join(directory, "scripts/asset-versions.json");
    const ledger = JSON.parse(readFileSync(manifest, "utf8")) as AssetVersionLedger;
    const changed = "const changed = true;\n";
    for (const version of Object.keys(ledger["public/management-query.js"])) {
      ledger["public/management-query.js"][version] = createHash("sha256").update(changed).digest("hex");
    }
    writeFileSync(manifest, JSON.stringify(ledger));
    writeFileSync(join(directory, "public/management-query.js"), changed);
    execFileSync("git", ["add", "public", "scripts/asset-versions.json"], { cwd: directory });
    const result = checkAssets(directory, "HEAD");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("recorded hashes are immutable");
  });

  const commit = (directory: string) => execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "--quiet", "-m", "Baseline"], { cwd: directory });
  const record = (directory: string) => spawnSync(process.execPath, ["--import", "tsx", join(root, "scripts/verify-asset-versions.ts"), "--record"], { cwd: directory, encoding: "utf8", env: subprocessEnv() });

  it("rejects an asset version missing from the ledger, and --record adds it without touching other hashes", () => {
    const directory = assetFixture();
    const manifest = join(directory, "scripts/asset-versions.json");
    const ledger = JSON.parse(readFileSync(manifest, "utf8")) as AssetVersionLedger;
    const [version, hash] = Object.entries(ledger["public/select.js"]).at(-1)!;
    delete ledger["public/select.js"][version];
    writeFileSync(manifest, JSON.stringify(ledger));
    const rejected = checkAssets(directory);
    expect(rejected.status).toBe(1);
    expect(rejected.stderr).toContain(`public/select.js v${version} is unrecorded. Rebuild and run pnpm record:assets.`);

    const recorded = record(directory);
    expect(recorded.status, recorded.stderr).toBe(0);
    expect(recorded.stdout).toBe("Asset version hashes verified.\n");
    const next = JSON.parse(readFileSync(manifest, "utf8")) as AssetVersionLedger;
    expect(next["public/select.js"][version]).toBe(hash);
    expect(next).toEqual({ ...ledger, "public/select.js": { ...ledger["public/select.js"], [version]: hash } });
    expect(readFileSync(manifest, "utf8").endsWith("\n")).toBe(true);
    expect(checkAssets(directory).status).toBe(0);
  });

  it("refuses to record a changed bundle over an immutable version", () => {
    const directory = assetFixture();
    const before = readFileSync(join(directory, "scripts/asset-versions.json"), "utf8");
    writeFileSync(join(directory, "public/select.js"), "const changed = true;\n");
    const result = record(directory);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("changed without a version bump");
    expect(readFileSync(join(directory, "scripts/asset-versions.json"), "utf8")).toBe(before);
  });

  it("compares with the base ledger only when the base has one", () => {
    const directory = assetFixture();
    commit(directory);
    // Baseline without a ledger: nothing to protect yet.
    expect(checkAssets(directory, "HEAD").status).toBe(0);
    execFileSync("git", ["add", "scripts/asset-versions.json"], { cwd: directory });
    commit(directory);
    // Baseline with an identical ledger, and an all-zero (new branch) base.
    expect(checkAssets(directory, "HEAD").status).toBe(0);
    expect(checkAssets(directory, "0".repeat(40)).status).toBe(0);
  });
});
